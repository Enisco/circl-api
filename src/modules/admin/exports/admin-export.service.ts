import { Injectable } from '@nestjs/common';
import { AdminExport, AdminExportKind, AdminExportState, Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException, PageMeta, buildPageMeta } from '@/common';
import { MediaService, StorageProvider } from '@/modules/platform/shared';
import { AuditService } from '../audit/audit.service';
import { AdminPrincipal } from '../common/admin-principal';
import { CreateExportDto, ListExportsDto } from '../dtos/admin-export.dto';
import { ListMembersDto } from '../dtos/analytics-filter.dto';
import { ListAuditDto } from '../dtos/admin-audit.dto';
import { ListEnforcementDto } from '../dtos/admin-enforcement.dto';
import { ListReportCasesDto } from '../dtos/admin-report-case.dto';
import { ListContentDto } from '../content/admin-content.dto';
import { ALL_TYPE_FILTERS } from '../content/admin-content.service';
import { ListSupportThreadsDto } from '../dtos/admin-support.dto';
import { AdminMemberService } from '../services/admin-member.service';
import { StaffRefView, staffRefSelect, toStaffRef } from '../serializers/admin-staff.serializer';
import { EXPORT_KINDS, columnOf, contactColumns, orderColumns } from './export-kinds';
import { AdminExportQueue } from './admin-export.queue';
import { ExportView, paramsOf, toExportView } from './admin-export.serializer';

/** §3.3: twenty an hour per staff member, then 429 `EXPORT_LIMIT`. */
export const EXPORTS_PER_HOUR = 20;

/** §5.26: the download link lives five minutes. */
export const DOWNLOAD_TTL_SECONDS = 300;

/** §5.26: `filters` and `columns`, together, at most 4 KB. */
const PARAMS_MAX_BYTES = 4096;

/** Paging params are filters nobody asked for. An export covers every matching row. */
const PAGING_PARAMS = ['page', 'perPage', 'sort', 'order'];

/** How many files one sweep deletes. Keeps a backlog from holding the job open for minutes. */
const EXPIRY_BATCH = 500;

/** §13.6: the file is kept seven days, the row a year. */
const ROW_TTL_DAYS = 365;

/** After this, a QUEUED or RUNNING export is one nothing is going to finish. */
const ABANDONED_AFTER_MS = 3_600_000;

/** Looks enough like an email address to be treated as one (§5.4's rule, same as the list). */
const LOOKS_LIKE_EMAIL = /@/;

/**
 * Staff exports (§5.26).
 *
 * The one action in the portal that takes member data out of it. Everything else — the list, the
 * detail page, a reveal — leaves the data on the server behind a masking rule and an audit entry;
 * an export puts it in a file on somebody's laptop, where no later change of permission can reach
 * it. Which is why this service is mostly checks, in this order:
 *
 *   1. the kind exists and is built,
 *   2. the caller holds the kind's own list permission, not just `exports:csv`,
 *   3. every column is on that kind's allowlist,
 *   4. contact columns need `members:pii_reveal`,
 *   5. the filters are the list's filters, validated by the list's own DTO,
 *   6. twenty an hour.
 *
 * And then the same checks again at download, because a staff member who loses `members:pii_reveal`
 * on Tuesday must not be able to download Monday's export of email addresses (§5.26, line 3047).
 */
@Injectable()
export class AdminExportService {
  constructor(
    private readonly database: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: AdminExportQueue,
    private readonly storage: StorageProvider,
    private readonly media: MediaService,
    private readonly members: AdminMemberService,
  ) {}

  async request(actor: AdminPrincipal, dto: CreateExportDto): Promise<ExportView> {
    const kind = EXPORT_KINDS[dto.kind];

    if (!kind.available) {
      throw ApiException.unprocessable(
        ApiErrorCode.NOT_AVAILABLE_YET,
        kind.pending ?? 'That export is not available.',
      );
    }

    this.assertListPermission(actor, dto.kind);

    const columns = this.assertColumns(actor, dto.kind, dto.columns);
    const filters = await this.assertFilters(actor, dto.kind, dto.filters ?? {});

    await this.assertQuota(actor);

    const { result } = await this.audit.mutate<AdminExport>(
      created => ({
        action: 'export.requested',
        targetType: 'EXPORT',
        targetId: created.id,
        targetLabel: dto.kind,
        metadata: {
          kind: dto.kind,
          columns,
          // The filters as sent, minus the free-text search: S14.3 is explicit that `q` never
          // reaches the trail, because a staff member typing somebody's email address into the
          // search box must not write that address into a second place that outlives the search.
          filters: redactSearch(filters),
        },
      }),
      tx =>
        tx.adminExport.create({
          data: {
            kind: dto.kind,
            requestedById: actor.id,
            params: { columns, filters } as Prisma.InputJsonValue,
          },
        }),
    );

    await this.queue.enqueue(result.id);

    return toExportView(result);
  }

  async list(
    actor: AdminPrincipal,
    dto: ListExportsDto,
  ): Promise<{ data: ExportView[]; meta: PageMeta }> {
    // `all=true` without `exports:read_all` falls back to the caller's own exports rather than
    // failing: the portal shows the toggle to everybody and a 403 on a list is a worse answer than
    // the list they are entitled to.
    const everyone = dto.all === true && actor.permissions.has('exports:read_all');
    const where: Prisma.AdminExportWhereInput = everyone ? {} : { requestedById: actor.id };
    const page = dto.page ?? 1;
    const perPage = dto.perPage ?? 25;

    const [rows, total] = await Promise.all([
      this.database.adminExport.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.database.adminExport.count({ where }),
    ]);

    const staff = everyone ? await this.staffRefs(rows.map(row => row.requestedById)) : new Map();

    return {
      data: rows.map(row => toExportView(row, staff.get(row.requestedById) ?? null)),
      meta: buildPageMeta({ currentPage: page, perPage }, total),
    };
  }

  async get(actor: AdminPrincipal, id: string): Promise<ExportView> {
    const row = await this.visible(actor, id);

    return toExportView(row);
  }

  /**
   * A link to the file, for five minutes (§5.26).
   *
   * **Owner only**, even for a manager holding `exports:read_all`: seeing that somebody exported
   * every member in Manchester is oversight, and downloading their copy of it is not. The spec is
   * explicit about the pair, and they are different questions.
   */
  async download(
    actor: AdminPrincipal,
    id: string,
  ): Promise<{ url: string; expiresAt: string; auditId: string | null }> {
    const row = await this.visible(actor, id);

    if (row.requestedById !== actor.id) {
      throw ApiException.forbidden(
        ApiErrorCode.FORBIDDEN,
        'Only the member of staff who asked for an export can download it.',
      );
    }

    // Re-checked now, not trusted from the request: permissions change, and an export is a file of
    // member data that outlives the afternoon somebody was allowed to ask for it.
    const { columns } = paramsOf(row);

    this.assertListPermission(actor, row.kind);
    this.assertContactColumns(actor, row.kind, columns);

    if (row.state !== AdminExportState.READY || !row.storageKey) {
      throw ApiException.conflict(
        ApiErrorCode.NOT_READY,
        row.state === AdminExportState.FAILED
          ? (row.error ?? 'That export failed.')
          : row.state === AdminExportState.EXPIRED
            ? 'That export has expired. Exports are kept for seven days; ask for it again.'
            : 'That export is still being built.',
      );
    }

    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      throw ApiException.conflict(
        ApiErrorCode.NOT_READY,
        'That export has expired. Exports are kept for seven days; ask for it again.',
      );
    }

    const url = this.storage.downloadUrl(row.storageKey, {
      expiresInSeconds: DOWNLOAD_TTL_SECONDS,
      filename: `${row.kind.toLowerCase()}-${row.createdAt.toISOString().slice(0, 10)}.csv`,
    });

    const auditId = await this.audit.note({
      action: 'export.downloaded',
      targetType: 'EXPORT',
      targetId: row.id,
      targetLabel: row.kind,
      metadata: { kind: row.kind, columns, rowCount: row.rowCount },
    });

    return {
      url,
      expiresAt: new Date(Date.now() + DOWNLOAD_TTL_SECONDS * 1000).toISOString(),
      auditId,
    };
  }

  /**
   * The seven-day sweep (S12.2), and the two other states time leaves behind.
   *
   * Three jobs in one pass, because they are the same question asked of different columns:
   *
   * - a READY export past its seven days loses its **file** and becomes EXPIRED — the row stays,
   *   because "who exported every member's email address in March" has to stay answerable;
   * - a row past a year goes entirely, which is the retention §13.6 sets for the receipt;
   * - a QUEUED or RUNNING export older than an hour is marked FAILED, because the alternative is a
   *   staff member polling a row that no worker is ever going to pick up (Redis restarted, the
   *   process died mid-build) with nothing on the screen to say so.
   */
  async expire(): Promise<{ expired: number; purged: number; abandoned: number }> {
    const now = Date.now();
    const due = await this.database.adminExport.findMany({
      where: { state: AdminExportState.READY, expiresAt: { lte: new Date(now) } },
      select: { id: true, storageKey: true },
      take: EXPIRY_BATCH,
    });

    // The file first, then the row: a delete that fails leaves a READY row and the next sweep
    // tries again, which is the right way round. Marking the row first would strand the object.
    for (const row of due) {
      if (row.storageKey) await this.storage.delete(row.storageKey);
    }

    if (due.length) {
      await this.database.adminExport.updateMany({
        where: { id: { in: due.map(row => row.id) } },
        data: { state: AdminExportState.EXPIRED, storageKey: null },
      });
    }

    const abandoned = await this.database.adminExport.updateMany({
      where: {
        state: { in: [AdminExportState.QUEUED, AdminExportState.RUNNING] },
        createdAt: { lt: new Date(now - ABANDONED_AFTER_MS) },
      },
      data: {
        state: AdminExportState.FAILED,
        completedAt: new Date(now),
        error: 'The export did not finish. Ask for it again.',
      },
    });

    const purged = await this.database.adminExport.deleteMany({
      where: { createdAt: { lt: new Date(now - ROW_TTL_DAYS * 86_400_000) } },
    });

    return { expired: due.length, purged: purged.count, abandoned: abandoned.count };
  }

  /**
   * The row, or a 404 — including for an export that exists and belongs to somebody else.
   *
   * A 403 would confirm that an id is an export, which is how an id guessed out of a log becomes a
   * way to learn who is exporting what. `exports:read_all` is what turns the 404 into a row.
   */
  private async visible(actor: AdminPrincipal, id: string): Promise<AdminExport> {
    const row = await this.database.adminExport.findUnique({ where: { id } });

    if (!row) throw ApiException.notFound('No such export.');

    if (row.requestedById !== actor.id && !actor.permissions.has('exports:read_all')) {
      throw ApiException.notFound('No such export.');
    }

    return row;
  }

  /** `exports:csv` is on the route; this is the kind's own list permission (§13.18). */
  private assertListPermission(actor: AdminPrincipal, kind: AdminExportKind): void {
    const allowed = EXPORT_KINDS[kind].listPermissions;

    if (!allowed.some(permission => actor.permissions.has(permission))) {
      throw ApiException.forbidden(
        ApiErrorCode.FORBIDDEN,
        `Exporting ${kind.toLowerCase().replace(/_/g, ' ')} needs permission to read the list it comes from.`,
      );
    }
  }

  private assertColumns(
    actor: AdminPrincipal,
    kind: AdminExportKind,
    requested: string[],
  ): string[] {
    const unknown = requested.filter(column => !columnOf(kind, column));

    if (unknown.length) {
      throw ApiException.badRequest(
        ApiErrorCode.VALIDATION_FAILED,
        `Not a column of a ${kind} export: ${unknown.join(', ')}.`,
        {
          details: [
            {
              field: 'columns',
              message: `One of: ${EXPORT_KINDS[kind].columns.map(column => column.key).join(', ')}.`,
            },
          ],
        },
      );
    }

    this.assertContactColumns(actor, kind, requested);

    return orderColumns(kind, requested);
  }

  private assertContactColumns(
    actor: AdminPrincipal,
    kind: AdminExportKind,
    requested: string[],
  ): void {
    const contact = contactColumns(kind, requested);

    if (contact.length && !actor.permissions.has('members:pii_reveal')) {
      throw ApiException.forbidden(
        ApiErrorCode.FORBIDDEN,
        `Exporting ${contact.join(' and ')} needs permission to reveal contact details.`,
        { details: contact.map(field => ({ field, message: 'Needs members:pii_reveal.' })) },
      );
    }
  }

  /**
   * The filters, run through the list's own DTO.
   *
   * Validated rather than trusted, and validated by the **same class** the list endpoint uses: a
   * filter the list refuses must not be silently dropped here, because a dropped filter widens an
   * export rather than narrowing it. "Members in Manchester" with a typo in `cityIds` would become
   * every member on the platform, in a file.
   */
  private async assertFilters(
    actor: AdminPrincipal,
    kind: AdminExportKind,
    filters: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const paging = PAGING_PARAMS.filter(param => filters[param] !== undefined);

    if (paging.length) {
      throw ApiException.badRequest(
        ApiErrorCode.VALIDATION_FAILED,
        `An export covers every matching row, so it takes no paging parameters: ${paging.join(', ')}.`,
        { details: paging.map(field => ({ field: `filters.${field}`, message: 'Not a filter.' })) },
      );
    }

    /**
     * Validated against the list's **own** DTO, per kind.
     *
     * `forbidNonWhitelisted`, so a filter the list does not take is a 400 naming it rather than a
     * file quietly built over everything: somebody who exported with `?stat=OPEN` instead of
     * `state` should be told, not handed the whole table.
     */
    const dtoForKind: Partial<Record<AdminExportKind, new () => object>> = {
      [AdminExportKind.MEMBERS]: ListMembersDto,
      [AdminExportKind.AUDIT]: ListAuditDto,
      [AdminExportKind.SUPPORT_THREADS]: ListSupportThreadsDto,
      [AdminExportKind.REPORTS]: ListReportCasesDto,
      [AdminExportKind.ENFORCEMENT]: ListEnforcementDto,
      [AdminExportKind.CONTENT]: ListContentDto,
    };
    const Dto = dtoForKind[kind];

    if (Dto) {
      const errors = validateSync(plainToInstance(Dto, filters), {
        whitelist: true,
        forbidNonWhitelisted: true,
      });

      if (errors.length) {
        throw ApiException.badRequest(
          ApiErrorCode.VALIDATION_FAILED,
          'Those are not that list’s filters.',
          {
            details: errors.map(error => ({
              field: `filters.${error.property}`,
              message: Object.values(error.constraints ?? {})[0] ?? 'Not a filter.',
            })),
          },
        );
      }
    }

    /**
     * A **type-specific** content filter is refused rather than ignored.
     *
     * The content export covers every kind in one file, and `?published=true` means something to
     * guides and nothing to shops. Applying it across the other sixteen would be wrong and
     * dropping it silently would produce a file nobody could explain — so it is named, with the
     * suggestion that belongs to it: ask for that kind's list instead.
     */
    if (kind === AdminExportKind.CONTENT) {
      const typeSpecific = ALL_TYPE_FILTERS.filter(filter => filters[filter] !== undefined);

      if (typeSpecific.length) {
        throw ApiException.badRequest(
          ApiErrorCode.VALIDATION_FAILED,
          `The content export covers every kind, so it takes no type-specific filter: ${typeSpecific.join(', ')}.`,
          {
            details: typeSpecific.map(field => ({
              field: `filters.${field}`,
              message: 'Belongs to one content type. Export from that type’s list instead.',
            })),
          },
        );
      }
    }

    if (kind === AdminExportKind.MEMBERS) {
      // The list answers an email search from somebody without `members:pii_reveal` with an empty
      // page (§5.4). An export cannot do that honestly — an empty CSV reads as "nobody matched" —
      // so it is refused here, and the worker can then search by email without asking again.
      if (
        typeof filters.q === 'string' &&
        LOOKS_LIKE_EMAIL.test(filters.q) &&
        !actor.permissions.has('members:pii_reveal')
      ) {
        throw ApiException.forbidden(
          ApiErrorCode.FORBIDDEN,
          'Searching by email address needs permission to reveal contact details.',
        );
      }

      // And resolved, not merely shaped. A city id or a taxonomy code is checked against the
      // database by `MemberFilterBuilder`, not by the DTO, so without this a typo would pass
      // validation and surface twenty seconds later as a failed job — or, worse, as a filter the
      // builder dropped and a file covering every member on the platform. §5.26 is explicit:
      // invalid filters are a 400 at request time, never widened to "all rows".
      await this.members.exportScope(
        plainToInstance(ListMembersDto, filters),
        actor.permissions.has('members:pii_reveal'),
      );
    }

    const size = Buffer.byteLength(JSON.stringify(filters), 'utf8');

    if (size > PARAMS_MAX_BYTES) {
      throw ApiException.badRequest(
        ApiErrorCode.VALIDATION_FAILED,
        'Those filters are too long to record against the export.',
        { details: [{ field: 'filters', message: `At most ${PARAMS_MAX_BYTES} bytes.` }] },
      );
    }

    return filters;
  }

  /**
   * Twenty an hour, counted from the rows rather than from Redis.
   *
   * The quota is "twenty exports an hour" and every export is a row, so the rows are the truth —
   * a counter in Redis would let twenty-one through after a restart, and would make the limit
   * untestable without reaching into Redis to arrange it. One indexed count on
   * `(requested_by_id, created_at)`, which is the index §4.11 already asks for.
   */
  private async assertQuota(actor: AdminPrincipal): Promise<void> {
    const since = new Date(Date.now() - 3_600_000);
    const used = await this.database.adminExport.count({
      where: { requestedById: actor.id, createdAt: { gte: since } },
    });

    if (used >= EXPORTS_PER_HOUR) {
      throw ApiException.rateLimited(
        ApiErrorCode.EXPORT_LIMIT,
        `That is ${EXPORTS_PER_HOUR} exports in an hour. Wait a while before asking for another.`,
        { data: { limit: EXPORTS_PER_HOUR, retryAfterSeconds: 3600 } },
      );
    }
  }

  private async staffRefs(ids: string[]): Promise<Map<string, StaffRefView>> {
    const unique = [...new Set(ids)];

    if (!unique.length) return new Map();

    const rows = await this.database.user.findMany({
      where: { id: { in: unique } },
      select: staffRefSelect,
    });

    return new Map(
      rows.map(row => [row.id, toStaffRef(row, key => this.media.sign(key))] as const),
    );
  }
}

/** `q` out, a marker in, so the entry still says a search was part of the question (S14.3). */
const redactSearch = (filters: Record<string, unknown>): Record<string, unknown> =>
  filters.q === undefined ? filters : { ...filters, q: undefined, search: '[redacted]' };
