import { Injectable, Logger } from '@nestjs/common';
import { AuditArea, Prisma } from '@prisma/client';
import { ApiErrorCode, ApiException, buildPageMeta, londonMidnight, shiftDateOnly } from '@/common';
import { PrismaService } from '@/infrastructure';
import { MediaService } from '@/modules/platform/shared';
import { AdminPrincipal } from '../common/admin-principal';
import { AUDIT_ACTIONS, AuditAction, auditActionList } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { ClientEventDto, ListAuditDto } from '../dtos/admin-audit.dto';
import { AuditEntryView, auditScopeFor, toAuditEntry } from '../serializers/audit-entry.serializer';
import { StaffRefView, staffRefSelect, toStaffRef } from '../serializers/admin-staff.serializer';

/** How many actors the filter dropdown offers. More than a team has, by a wide margin. */
const ACTOR_LIMIT = 200;

/** What one metadata object may carry, serialised (§5.23). */
const METADATA_MAX_BYTES = 4096;

/**
 * §5.23: reading the trail.
 *
 * The writing has been in place since M0 and nothing could read it in the portal — three
 * milestones of entries, every one of them recorded so that somebody could be asked about it, and
 * no endpoint that would let anybody ask. That is the gap this closes.
 *
 * **R8 is applied in the query, never after it**, and `auditScopeFor` is the one expression of it.
 * Post-filtering would mean the count and the page disagree — a reader on page three of a list
 * whose rows were quietly dropped sees a short page and no explanation — and it would mean the
 * rows reach this process at all, which for a safeguarding entry is the thing being prevented.
 *
 * Nothing here deletes or edits an entry. The only write on the whole surface is
 * `clientEvent`, which appends.
 */
@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger(AdminAuditService.name);

  constructor(
    private readonly database: PrismaService,
    private readonly media: MediaService,
    private readonly audit: AuditService,
  ) {}

  async list(actor: AdminPrincipal, query: ListAuditDto) {
    query.assertDepth();

    const where = this.whereFor(actor, query);

    const [total, rows] = await this.database.$transaction([
      this.database.auditLog.count({ where }),
      this.database.auditLog.findMany({
        where,
        // Newest first, which is the only order a trail is read in. The id is the tiebreaker so a
        // page boundary between two entries written in the same millisecond cannot repeat or skip
        // one — two entries from one transaction share their timestamp exactly.
        orderBy: [{ occurredAt: query.order ?? 'desc' }, { id: 'desc' }],
        skip: (query.currentPage - 1) * query.size,
        take: query.size,
      }),
    ]);

    const staff = await this.staffFor(rows.map(row => row.actorId));

    return {
      data: rows.map(row => this.toView(row, staff)),
      meta: buildPageMeta({ currentPage: query.currentPage, perPage: query.size }, total),
    };
  }

  /**
   * One entry.
   *
   * A 404 rather than a 403 where it is outside the caller's scope (§5.23), and the distinction
   * matters: a 403 on an id confirms that an entry with that id exists, which for a safeguarding
   * action is most of what the reader was not allowed to know.
   */
  async findOne(actor: AdminPrincipal, id: string): Promise<AuditEntryView> {
    const scope = this.scopeOrRefuse(actor);
    const row = await this.database.auditLog.findFirst({ where: { AND: [{ id }, scope] } });

    if (!row) throw ApiException.notFound('No such audit entry.');

    const staff = await this.staffFor([row.actorId]);

    return this.toView(row, staff);
  }

  /** The action filter's options, from the registry the writer itself uses. */
  actions(): Array<{ action: AuditAction; area: AuditArea; label: string }> {
    return auditActionList().map(entry => ({
      ...entry,
      label: labelOf(entry.action),
    }));
  }

  /**
   * The staff who appear in entries this caller may read (§5.23).
   *
   * Scoped like everything else, which is the point of it being an endpoint rather than the team
   * list: a `audit:read_self` holder's actor filter contains exactly one person, themselves, and a
   * dropdown built from `admin/team` would offer them colleagues whose entries they cannot see and
   * return nothing for each.
   *
   * **A `groupBy`, not a `take` over the rows.** The first version selected `distinct` actor ids
   * with `take: 200`, which is "the first two hundred rows the database happened to read" — on a
   * trail of twelve thousand entries that returned a page of ids belonging to staff accounts that
   * had since been deleted, and therefore an **empty dropdown**. Grouped and ordered by each
   * actor's most recent entry, the list is exact, deterministic, and in the order a filter wants:
   * whoever acted last, first.
   *
   * **A deleted staff account drops out of the list while its entries stay in the trail.**
   * `actorId` is a plain column with no foreign key, deliberately — the trail has to outlive the
   * account, and an append-only table cannot be cascaded. So there is no `StaffRef` to return for
   * one, and the honest answer is to leave it out of the dropdown rather than invent a name. Those
   * entries are still readable; they are found by action, area or target rather than by actor.
   */
  async actors(actor: AdminPrincipal): Promise<StaffRefView[]> {
    const scope = this.scopeOrRefuse(actor);
    const groups = await this.database.auditLog.groupBy({
      by: ['actorId'],
      where: { AND: [{ actorId: { not: null } }, scope] },
      _max: { occurredAt: true },
      orderBy: { _max: { occurredAt: 'desc' } },
      take: ACTOR_LIMIT,
    });

    const ids = groups.map(group => group.actorId).filter((id): id is string => !!id);

    if (!ids.length) return [];

    const staff = await this.database.user.findMany({
      where: { id: { in: ids } },
      select: staffRefSelect,
    });
    const byId = new Map(staff.map(person => [person.id, person]));

    // Kept in the grouped order — most recently active first — rather than re-sorted by name:
    // the person who just did something is the one somebody is looking for.
    return ids
      .map(id => byId.get(id))
      .filter((person): person is NonNullable<typeof person> => !!person)
      .map(person => toStaffRef(person, this.media.sign));
  }

  /**
   * One entry for something only the client can see (§5.23).
   *
   * Three actions, allowlisted: a CSV assembled in the browser from data it already had leaves no
   * request for the server to audit, so without this the one act that takes member data off the
   * platform is the one act with no trail. Everything else is audited where it happens.
   *
   * The action is **mapped to its registered area here**, not taken from the caller. A client that
   * could name the area could file its own act under `ANALYTICS` and keep it out of the view of
   * everybody holding `audit:read_area`.
   */
  async clientEvent(actor: AdminPrincipal, dto: ClientEventDto): Promise<{ recorded: true }> {
    const area = AUDIT_ACTIONS[dto.action];

    if (!area) {
      // Unreachable while the DTO's allowlist and the registry agree, and here because the day
      // they stop agreeing this is a 400 rather than a row with no area.
      throw ApiException.badRequest(
        ApiErrorCode.VALIDATION_FAILED,
        'That is not an action the portal may record.',
      );
    }

    const metadata = dto.metadata ?? {};

    if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > METADATA_MAX_BYTES) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'That is too much detail for one entry.',
        {
          data: { limit: METADATA_MAX_BYTES },
          details: [{ field: 'metadata', message: `Up to ${METADATA_MAX_BYTES} bytes.` }],
        },
      );
    }

    await this.audit.note({ action: dto.action, area, metadata });

    this.logger.log(`Client event ${dto.action} recorded for ${actor.id}`);

    return { recorded: true };
  }

  // ─── Filters ───────────────────────────────────────────────────────────────

  private scopeOrRefuse(actor: AdminPrincipal): Prisma.AuditLogWhereInput {
    const scope = auditScopeFor(actor);

    if (!scope) {
      // Belt to the route's braces: the guard already demands one of the three permissions, and
      // this is what stops a fourth way in — a route added later with the wrong decorator — from
      // serving the whole trail.
      throw ApiException.forbidden(ApiErrorCode.FORBIDDEN, 'You cannot read the audit trail.');
    }

    return scope;
  }

  /**
   * The caller's scope, narrowed by their filters.
   *
   * The two are ANDed rather than merged, and that is deliberate: a filter narrows **within** what
   * R8 allows. A `audit:read_area` holder asking for `area=TEAM` gets their own TEAM actions —
   * which their scope already permits — rather than everybody's, and rather than a refusal.
   */
  /**
   * The same predicate the list uses, for §5.26's export.
   *
   * Public rather than copied, and that is the whole point: R8's scope is the first clause of it,
   * so an export applies the caller's own scope **by construction**. A second implementation
   * would be a way around the audit scope — the one place in this API where that is worth saying
   * out loud, because an export is also the one place where data leaves the portal.
   */
  exportWhere(actor: AdminPrincipal, query: ListAuditDto): Prisma.AuditLogWhereInput {
    return this.whereFor(actor, query);
  }

  private whereFor(actor: AdminPrincipal, query: ListAuditDto): Prisma.AuditLogWhereInput {
    const filters: Prisma.AuditLogWhereInput[] = [this.scopeOrRefuse(actor)];

    if (query.actorId) filters.push({ actorId: query.actorId });
    if (query.action?.length) filters.push({ action: { in: query.action } });
    if (query.area?.length) filters.push({ area: { in: query.area } });
    if (query.targetType) filters.push({ targetType: query.targetType });
    if (query.targetId) filters.push({ targetId: query.targetId });
    if (query.reasonCode) filters.push({ reasonCode: query.reasonCode });

    // London days, inclusive at both ends: `to` is the end of that day, so a single-day range is
    // the same date twice. Resolved to instants here rather than compared as strings, because
    // `occurredAt` is a timestamp and London is an hour off UTC for seven months of the year —
    // a naive comparison would lose the first hour of every summer day.
    if (query.from) filters.push({ occurredAt: { gte: londonMidnight(query.from) } });
    if (query.to) filters.push({ occurredAt: { lt: londonMidnight(shiftDateOnly(query.to, 1)) } });

    if (query.q) {
      filters.push({ targetLabel: { contains: query.q, mode: 'insensitive' } });
    }

    return { AND: filters };
  }

  private async staffFor(ids: Array<string | null>) {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];

    if (!unique.length) return new Map<string, StaffRefView>();

    const rows = await this.database.user.findMany({
      where: { id: { in: unique } },
      select: staffRefSelect,
    });

    return new Map(rows.map(person => [person.id, toStaffRef(person, this.media.sign)]));
  }

  private toView(
    row: Parameters<typeof toAuditEntry>[0],
    staff: Map<string, StaffRefView>,
  ): AuditEntryView {
    return toAuditEntry(row, row.actorId ? (staff.get(row.actorId) ?? null) : null);
  }
}

/** `member.suspended` → "Member suspended". The same shape `admin/meta` has served all along. */
const labelOf = (action: string): string =>
  action
    .replace(/\./g, ' ')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^./, first => first.toUpperCase());
