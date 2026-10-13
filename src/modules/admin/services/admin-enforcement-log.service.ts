import { Injectable } from '@nestjs/common';
import { AdminReasonCode, Prisma, ReportTargetType } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { buildPageMeta } from '@/common';
import { MediaService } from '@/modules/platform/shared';
import {
  EnforcementKind,
  ListActiveSuspensionsDto,
  ListBlocksDto,
  ListEnforcementDto,
} from '../dtos/admin-enforcement.dto';
import { toMemberRef } from '../serializers/admin-member.serializer';
import { caseMemberSelect } from '../serializers/admin-report-case.serializer';
import { staffRefSelect, toStaffRef } from '../serializers/admin-staff.serializer';

/** One row of the log, whichever table it came from. */
interface LogRow {
  kind: EnforcementKind;
  id: string;
  userId: string;
  reasonCode: AdminReasonCode;
  policySubtype: string | null;
  note: string | null;
  sourceType: string;
  sourceId: string | null;
  sourceTargetType: ReportTargetType | null;
  issuedById: string;
  issuedAt: Date;
  /** A strike's expiry, or a suspension's end. Null on a permanent suspension. */
  expiresAt: Date | null;
  /** Revoked for a strike, lifted for a suspension — the same fact under two names. */
  endedAt: Date | null;
  endedById: string | null;
  endedReason: string | null;
  isActive: boolean;
  notifiedAt: Date | null;
}

/**
 * The enforcement log and the block aggregate (§5.14).
 *
 * Read-only. Every one of these records is *written* by `AdminEnforcementService` as part of a
 * decision, with its own audit entry — this is the history those writes leave behind, and a second
 * way to create one would be a way to strike somebody with no decision attached to it.
 *
 * `Strike` and `Suspension` are separate tables with the same shape and different column names,
 * which is right for writing and awkward for reading: §5.14 asks for one list of both, paged and
 * sorted together. That is a `UNION ALL` rather than two queries merged in memory, because merging
 * pages client-side gives a list whose second page overlaps its first.
 */
@Injectable()
export class AdminEnforcementLogService {
  constructor(
    private readonly database: PrismaService,
    private readonly media: MediaService,
  ) {}

  /**
   * The log's own rows, for §5.26's export.
   *
   * It reuses `list` rather than rebuilding the union, which is the point: the union is where
   * "active" means two different things in two tables — a strike runs out, a permanent suspension
   * never does — and a second copy of that would export a different set of rows from the screen.
   *
   * Offset paging, which is safe here because the order is `issued_at DESC, id ASC`: a stable
   * total order, so a row cannot move between pages while the file is built.
   */
  async exportPage(query: ListEnforcementDto, page: number, size: number) {
    /**
     * Cloned through the prototype, not spread.
     *
     * `{ ...query }` is a plain object, and `list` calls `query.sortField(...)` — a prototype
     * method. A spread would have thrown `sortField is not a function` on the first page of every
     * enforcement export, and the `as ListEnforcementDto` that a spread needs is exactly the cast
     * that hides it from the compiler.
     */
    const paged: ListEnforcementDto = Object.assign(
      Object.create(Object.getPrototypeOf(query) as object) as ListEnforcementDto,
      query,
      { currentPage: page, size },
    );

    const { data } = await this.list(paged);

    return data;
  }

  async list(query: ListEnforcementDto) {
    const kinds: EnforcementKind[] = query.kind?.length ? query.kind : ['STRIKE', 'SUSPENSION'];
    const sort = query.sortField(['issuedAt', 'expiresAt'], 'issuedAt');
    const direction = query.order === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
    const now = new Date();

    // Built once and used by both halves of the union, so a filter cannot be applied to strikes
    // and forgotten on suspensions — which would read as "this member has no suspensions" rather
    // than as a bug.
    const strikeWhere: Prisma.Sql[] = [Prisma.sql`TRUE`];
    const suspensionWhere: Prisma.Sql[] = [Prisma.sql`TRUE`];

    if (query.memberId) {
      strikeWhere.push(Prisma.sql`s."user_id" = ${query.memberId}`);
      suspensionWhere.push(Prisma.sql`p."user_id" = ${query.memberId}`);
    }

    if (query.issuedById) {
      strikeWhere.push(Prisma.sql`s."issued_by_id" = ${query.issuedById}`);
      suspensionWhere.push(Prisma.sql`p."issued_by_id" = ${query.issuedById}`);
    }

    if (query.reasonCode?.length) {
      const codes = Prisma.join(query.reasonCode);

      strikeWhere.push(Prisma.sql`s."reason_code"::text IN (${codes})`);
      suspensionWhere.push(Prisma.sql`p."reason_code"::text IN (${codes})`);
    }

    if (query.from) {
      strikeWhere.push(Prisma.sql`s."issued_at" >= ${new Date(query.from)}`);
      suspensionWhere.push(Prisma.sql`p."starts_at" >= ${new Date(query.from)}`);
    }

    if (query.to) {
      strikeWhere.push(Prisma.sql`s."issued_at" < ${new Date(query.to)}`);
      suspensionWhere.push(Prisma.sql`p."starts_at" < ${new Date(query.to)}`);
    }

    if (query.active) {
      // Active means different things in the two tables, and this is the one filter that cannot be
      // shared: a strike runs out, a suspension may never. A permanent suspension — `ends_at IS
      // NULL` — is the most active row there is, and a naive `ends_at > now()` would hide exactly
      // those.
      strikeWhere.push(Prisma.sql`s."revoked_at" IS NULL AND s."expires_at" > ${now}`);
      suspensionWhere.push(
        Prisma.sql`p."lifted_at" IS NULL AND (p."ends_at" IS NULL OR p."ends_at" > ${now})`,
      );
    }

    const strikes = Prisma.sql`
      SELECT 'STRIKE' AS kind, s."id", s."user_id", s."reason_code"::text AS reason_code,
             s."policy_subtype", s."note", s."source_type"::text AS source_type, s."source_id",
             s."source_target_type"::text AS source_target_type, s."issued_by_id",
             s."issued_at", s."expires_at", s."revoked_at" AS ended_at,
             s."revoked_by_id" AS ended_by_id, s."revoke_reason" AS ended_reason,
             s."notified_at",
             (s."revoked_at" IS NULL AND s."expires_at" > ${now}) AS is_active
      FROM "strikes" s
      WHERE ${Prisma.join(strikeWhere, ' AND ')}
    `;

    const suspensions = Prisma.sql`
      SELECT 'SUSPENSION' AS kind, p."id", p."user_id", p."reason_code"::text AS reason_code,
             p."policy_subtype", p."note", p."source_type"::text AS source_type, p."source_id",
             p."source_target_type"::text AS source_target_type, p."issued_by_id",
             p."starts_at" AS issued_at, p."ends_at" AS expires_at, p."lifted_at" AS ended_at,
             p."lifted_by_id" AS ended_by_id, p."lift_reason" AS ended_reason,
             NULL::timestamptz AS notified_at,
             (p."lifted_at" IS NULL AND (p."ends_at" IS NULL OR p."ends_at" > ${now})) AS is_active
      FROM "suspensions" p
      WHERE ${Prisma.join(suspensionWhere, ' AND ')}
    `;

    const union =
      kinds.length === 2
        ? Prisma.sql`${strikes} UNION ALL ${suspensions}`
        : kinds[0] === 'STRIKE'
          ? strikes
          : suspensions;

    // NULLS LAST in both directions when sorting on the expiry: a permanent suspension has no end
    // date, which is not "the furthest away" or "the soonest" — it is the absence of one, and
    // Postgres' default would sort it to whichever end of the list happens to look wrong.
    const orderBy =
      sort === 'expiresAt'
        ? Prisma.sql`ORDER BY "expires_at" ${direction} NULLS LAST, "issued_at" DESC`
        : Prisma.sql`ORDER BY "issued_at" ${direction}, "id" ASC`;

    const [rows, counted] = await Promise.all([
      this.database.$queryRaw<
        Array<{
          kind: EnforcementKind;
          id: string;
          user_id: string;
          reason_code: AdminReasonCode;
          policy_subtype: string | null;
          note: string | null;
          source_type: string;
          source_id: string | null;
          source_target_type: ReportTargetType | null;
          issued_by_id: string;
          issued_at: Date;
          expires_at: Date | null;
          ended_at: Date | null;
          ended_by_id: string | null;
          ended_reason: string | null;
          notified_at: Date | null;
          is_active: boolean;
        }>
      >`
        WITH log AS (${union})
        SELECT * FROM log ${orderBy}
        LIMIT ${query.size} OFFSET ${(query.currentPage - 1) * query.size}
      `,
      this.database.$queryRaw<Array<{ total: bigint }>>`
        WITH log AS (${union}) SELECT COUNT(*)::bigint AS total FROM log
      `,
    ]);

    const log: LogRow[] = rows.map(row => ({
      kind: row.kind,
      id: row.id,
      userId: row.user_id,
      reasonCode: row.reason_code,
      policySubtype: row.policy_subtype,
      note: row.note,
      sourceType: row.source_type,
      sourceId: row.source_id,
      sourceTargetType: row.source_target_type,
      issuedById: row.issued_by_id,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      endedAt: row.ended_at,
      endedById: row.ended_by_id,
      endedReason: row.ended_reason,
      notifiedAt: row.notified_at,
      isActive: row.is_active,
    }));

    const [members, staff] = await Promise.all([
      this.members(log.map(row => row.userId)),
      this.staff(log.flatMap(row => [row.issuedById, row.endedById])),
    ]);

    return {
      data: log.map(row => ({
        kind: row.kind,
        id: row.id,
        member: members.get(row.userId) ?? null,
        reasonCode: row.reasonCode,
        policySubtype: row.policySubtype,
        note: row.note,
        source: {
          type: row.sourceType,
          id: row.sourceId,
          targetType: row.sourceTargetType,
        },
        issuedBy: staff.get(row.issuedById) ?? null,
        issuedAt: row.issuedAt.toISOString(),
        expiresAt: row.expiresAt?.toISOString() ?? null,
        // One pair of names for both tables. A strike is revoked and a suspension is lifted, which
        // is the same fact about the same kind of record, and a portal switching on `kind` to read
        // one of two differently-named fields is a portal that will read the wrong one.
        endedAt: row.endedAt?.toISOString() ?? null,
        endedBy: row.endedById ? (staff.get(row.endedById) ?? null) : null,
        endedReason: row.endedReason,
        isActive: row.isActive,
        // Null on a suspension: the member is told by the sign-in refusal itself, so there is no
        // separate moment to record. Null on a strike means it was recorded and they do not know.
        notifiedAt: row.notifiedAt?.toISOString() ?? null,
      })),
      meta: buildPageMeta(
        { currentPage: query.currentPage, perPage: query.size },
        Number(counted[0]?.total ?? 0),
      ),
    };
  }

  /**
   * Who is suspended right now (§5.14).
   *
   * Its own endpoint rather than `?kind=SUSPENSION&active=true` because it answers a different
   * question — "who cannot use the platform today" — and because of `permanentCount`: the number
   * staff actually want is how many of these have no end date, and that is not something a paged
   * list of rows can be asked.
   */
  async activeSuspensions(query: ListActiveSuspensionsDto) {
    const now = new Date();
    const where: Prisma.SuspensionWhereInput = {
      liftedAt: null,
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
    };

    const [total, rows, permanentCount] = await Promise.all([
      this.database.suspension.count({ where }),
      this.database.suspension.findMany({
        where,
        // Nulls last: the permanent ones are not "furthest away", they are the ones with no date.
        // Soonest-ending first, because that is the list staff work down.
        orderBy: [{ endsAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
        skip: (query.currentPage - 1) * query.size,
        take: query.size,
      }),
      this.database.suspension.count({ where: { liftedAt: null, endsAt: null } }),
    ]);

    const [members, staff] = await Promise.all([
      this.members(rows.map(row => row.userId)),
      this.staff(rows.map(row => row.issuedById)),
    ]);

    return {
      data: rows.map(row => ({
        id: row.id,
        member: members.get(row.userId) ?? null,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt?.toISOString() ?? null,
        // Said rather than left to be inferred from a null, which is the same shape the member's
        // own suspension notice uses (§13.2).
        isPermanent: row.endsAt === null,
        reasonCode: row.reasonCode,
        policySubtype: row.policySubtype,
        note: row.note,
        issuedBy: staff.get(row.issuedById) ?? null,
        source: {
          type: row.sourceType,
          id: row.sourceId,
          targetType: row.sourceTargetType,
        },
      })),
      meta: buildPageMeta({ currentPage: query.currentPage, perPage: query.size }, total, {
        permanentCount,
      }),
    };
  }

  /**
   * Who is being blocked by a lot of people (§5.14).
   *
   * **Aggregated, and individual pairs are deliberately not returned.** Who blocked whom is
   * private between those two members: §3.1.5 is explicit that a block is invisible to the person
   * blocked, and a staff list of pairs would be a list of exactly that. The count is the signal
   * worth having — somebody fifteen people have blocked is a pattern — and it carries no names.
   *
   * The individual pairs remain reachable on one member's own tab, where a reviewer is already
   * looking at a specific case rather than browsing.
   */
  async blocks(query: ListBlocksDto) {
    const floor = query.minBlocksReceived ?? 3;
    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(query.to) : null;

    // Two counts per member, and the difference between them is the point. `blocks_received` is
    // the lifetime total, which is what says whether this is a pattern; the in-range count is what
    // says whether it is happening *now*. A single number filtered by date would make a member
    // blocked forty times last year look clean this month, and a single lifetime number would make
    // a new account look harmless.
    const rows = await this.database.$queryRaw<
      Array<{
        blocked_id: string;
        blocks_received: bigint;
        blocks_received_in_range: bigint;
        last_blocked_at: Date;
      }>
    >`
      SELECT b."blocked_id",
             COUNT(*)::bigint AS blocks_received,
             COUNT(*) FILTER (
               WHERE (${from}::timestamptz IS NULL OR b."created_at" >= ${from}::timestamptz)
                 AND (${to}::timestamptz IS NULL OR b."created_at" < ${to}::timestamptz)
             )::bigint AS blocks_received_in_range,
             MAX(b."created_at") AS last_blocked_at
      FROM "blocks" b
      -- Blocks placed on an account that has since gone say nothing about anybody who is still
      -- here, and the member reference would be a blank row in the list.
      JOIN "users" u ON u."id" = b."blocked_id"
        AND u."deleted_at" IS NULL AND u."is_anonymised" = false
      GROUP BY b."blocked_id"
      HAVING COUNT(*) >= ${floor}
      ORDER BY blocks_received DESC, last_blocked_at DESC
      LIMIT ${query.size} OFFSET ${(query.currentPage - 1) * query.size}
    `;

    const counted = await this.database.$queryRaw<Array<{ total: bigint }>>`
      SELECT COUNT(*)::bigint AS total FROM (
        SELECT b."blocked_id"
        FROM "blocks" b
        JOIN "users" u ON u."id" = b."blocked_id"
          AND u."deleted_at" IS NULL AND u."is_anonymised" = false
        GROUP BY b."blocked_id"
        HAVING COUNT(*) >= ${floor}
      ) AS counted
    `;

    const members = await this.members(rows.map(row => row.blocked_id));

    return {
      data: rows.map(row => ({
        member: members.get(row.blocked_id) ?? null,
        blocksReceived: Number(row.blocks_received),
        blocksReceivedInRange: Number(row.blocks_received_in_range),
        lastBlockedAt: row.last_blocked_at.toISOString(),
      })),
      meta: buildPageMeta(
        { currentPage: query.currentPage, perPage: query.size },
        Number(counted[0]?.total ?? 0),
        { minBlocksReceived: floor },
      ),
    };
  }

  // ─── Plumbing ──────────────────────────────────────────────────────────────

  private async members(ids: Array<string | null>) {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];

    if (!wanted.length) return new Map<string, ReturnType<typeof toMemberRef>>();

    const rows = await this.database.user.findMany({
      where: { id: { in: wanted } },
      select: caseMemberSelect,
    });

    return new Map(rows.map(row => [row.id, toMemberRef(row, this.media.sign)]));
  }

  /**
   * The staff names, resolved against the live table.
   *
   * `issued_by_id` carries no foreign key, deliberately — the same reason `ModerationAction` does
   * not: an enforcement record has to outlive the staff account that issued it. So this finds
   * nothing for somebody who has left, and the row renders with a null `issuedBy` rather than
   * failing.
   */
  private async staff(ids: Array<string | null>) {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];

    if (!wanted.length) return new Map<string, ReturnType<typeof toStaffRef>>();

    const rows = await this.database.user.findMany({
      where: { id: { in: wanted } },
      select: staffRefSelect,
    });

    return new Map(rows.map(row => [row.id, toStaffRef(row, this.media.sign)]));
  }
}
