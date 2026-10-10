import { Injectable } from '@nestjs/common';
import { NoteSubjectType, Prisma, TaxonomyKind } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import {
  ApiException,
  PageMeta,
  SYSTEM_CONFIG_KEYS,
  buildPageMeta,
  londonMidnight,
  shiftDateOnly,
} from '@/common';
import { MediaService, SystemConfigService, TaxonomyService } from '@/modules/platform/shared';
import { AuditService } from '../audit/audit.service';
import { AdminPrincipal } from '../common/admin-principal';
import { ListMembersDto } from '../dtos/analytics-filter.dto';
import { RevealMemberDto } from '../dtos/admin-member.dto';
import { MemberFilterBuilder } from '../filters/member-filter.builder';
import {
  AdminMemberContext,
  AdminMemberRowView,
  AdminMemberSource,
  AgeBand,
  maskedPhoneOf,
  toAdminMemberView,
} from '../serializers/admin-member.serializer';
import { maskIp } from '../serializers/pii.serializer';
import { AdminNoteService, InternalNoteView } from './admin-note.service';
import { EnforcementService } from './enforcement.service';

/** What the list may be sorted by (§5.4). Anything else is a 400 naming the field. */
const SORTS = ['createdAt', 'lastActiveAt', 'name', 'strikes', 'reportsReceived'] as const;

type MemberSort = (typeof SORTS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+$/;

export interface AdminMemberDetailView extends AdminMemberRowView {
  phoneMasked: string | null;
  headline: string | null;
  memberSince: string;
  emailVerifiedAt: string | null;
  lastLoginAt: string | null;
  loginLocked: boolean;
  counts: {
    requests: number;
    offers: number;
    posts: number;
    replies: number;
    guides: number;
    groups: number;
    deals: number;
    reviewsReceived: number;
    ratingAverage: number | null;
    reportsFiled: number;
    reportsReceived: number;
    blocksReceived: number;
  };
  pinnedNotes: InternalNoteView[];
  openCases: { reports: number; guard: number; support: number; disputes: number };
  suggestSuspension: boolean;
}

/**
 * Members, for staff.
 *
 * The list is one raw query and one hydration rather than a Prisma `findMany`, which is a
 * deliberate trade. Two of the five sorts the spec asks for are over aggregates — active strikes
 * and reports received — and an "active strike" is `revoked_at IS NULL AND expires_at > now()`,
 * which Prisma can count or can sort by but not both. Written as SQL, the numbers in the two
 * columns and the order of the rows come from the same expression, so the list cannot be sorted by
 * one thing while displaying another. `MemberFilterBuilder` supplies the filter half of that query
 * in the same call that would have supplied the Prisma `where`, so there is still one definition
 * of who counts as a member.
 */
@Injectable()
export class AdminMemberService {
  constructor(
    private readonly database: PrismaService,
    private readonly filters: MemberFilterBuilder,
    private readonly taxonomy: TaxonomyService,
    private readonly media: MediaService,
    private readonly audit: AuditService,
    private readonly notes: AdminNoteService,
    private readonly enforcement: EnforcementService,
    private readonly config: SystemConfigService,
  ) {}

  async list(
    actor: AdminPrincipal,
    dto: ListMembersDto,
  ): Promise<{ data: AdminMemberRowView[]; meta: PageMeta }> {
    dto.assertDepth();

    const sort = dto.sortField<MemberSort>(SORTS, 'createdAt');
    const order = dto.order ?? 'desc';
    const now = new Date();

    const filter = await this.filters.resolve(dto, {
      // The member list has no default date range (§5.4): `from`/`to` mean sign-up date here, and
      // defaulting them to the last thirty days would show a staff member "the members" and
      // silently mean "the members who joined this month".
      defaultRange: false,
      dateField: 'createdAt',
    });

    const search = this.searchPredicate(actor, dto.q);

    // An email query from somebody without `members:pii_reveal` matches nothing (§5.4), so that
    // the list cannot be used to confirm which address an account holds. Answered here rather than
    // with a predicate that cannot match, so the response is honestly empty rather than a query
    // written to fail.
    if (search === 'DENIED') {
      return {
        data: [],
        meta: buildPageMeta({ currentPage: dto.currentPage, perPage: dto.size }, 0, {
          filtersApplied: filter.applied,
        }),
      };
    }

    const predicates = [filter.sql, ...this.listPredicates(dto, now), ...(search ? [search] : [])];
    const where = Prisma.join(predicates, ' AND ');
    const offset = (dto.currentPage - 1) * dto.size;

    const rows = await this.database.$queryRaw<
      Array<{ id: string; active_strikes: bigint; reports_received: bigint; total: bigint }>
    >`
      SELECT u."id",
             (
               SELECT COUNT(*) FROM "strikes" s
               WHERE s."user_id" = u."id" AND s."revoked_at" IS NULL AND s."expires_at" > ${now}
             ) AS active_strikes,
             (SELECT COUNT(*) FROM "reports" r WHERE r."target_user_id" = u."id") AS reports_received,
             COUNT(*) OVER () AS total
      FROM "users" u
      LEFT JOIN "user_profile" p ON p."user_id" = u."id"
      WHERE ${where}
      ORDER BY ${this.orderBy(sort, order)}
      LIMIT ${dto.size} OFFSET ${offset}
    `;

    // `COUNT(*) OVER ()` rides along on the page's own rows, which is one query instead of two —
    // and gives nothing at all when the page is past the end of the result set. Without this, page
    // five of a three-page result reported a total of zero, so a staff member following a stale
    // link was told there are no members rather than that they are on the wrong page.
    const total = rows.length
      ? Number(rows[0].total)
      : dto.currentPage > 1
        ? await this.countMatching(where)
        : 0;
    const context = await this.context(filter.range?.to);
    const sources = await this.sourcesFor(rows.map(row => row.id));

    const data = rows
      .map(row => {
        const source = sources.get(row.id);

        return source
          ? toAdminMemberView(
              source,
              {
                activeStrikes: Number(row.active_strikes),
                reportsReceived: Number(row.reports_received),
              },
              context,
            )
          : null;
      })
      .filter((row): row is AdminMemberRowView => row !== null);

    return {
      data,
      meta: buildPageMeta({ currentPage: dto.currentPage, perPage: dto.size }, total, {
        filtersApplied: filter.applied,
        ...(filter.range ? { range: { from: filter.range.from, to: filter.range.to } } : {}),
      }),
    };
  }

  /** One member, with everything the detail page's header and summary need. */
  async detail(id: string): Promise<AdminMemberDetailView> {
    const source = await this.memberOrFail(id);

    const [
      counts,
      reportsFiled,
      reportsReceived,
      blocksReceived,
      reputation,
      auth,
      activeStrikes,
      pinnedNotes,
      openCases,
      threshold,
    ] = await Promise.all([
      this.contentCounts(id),
      this.database.report.count({ where: { reporterId: id } }),
      this.database.report.count({ where: { targetUserId: id } }),
      this.database.block.count({ where: { blockedId: id } }),
      this.database.reputationSummary.findUnique({ where: { userId: id } }),
      this.database.userAuth.findUnique({
        where: { userId: id },
        select: { emailVerifiedAt: true, lastLoginAt: true, isBlocked: true },
      }),
      this.enforcement.activeStrikeCount(id),
      this.notes.pinned(NoteSubjectType.MEMBER, id),
      this.openCases(id),
      this.config.get(SYSTEM_CONFIG_KEYS.SUGGEST_SUSPENSION_AT_STRIKES),
    ]);

    const context = await this.context();
    const row = toAdminMemberView(source, { activeStrikes, reportsReceived }, context);

    return {
      ...row,
      phoneMasked: maskedPhoneOf(source),
      headline: source.profile?.headline ?? null,
      memberSince: source.createdAt.toISOString(),
      emailVerifiedAt: auth?.emailVerifiedAt?.toISOString() ?? null,
      lastLoginAt: auth?.lastLoginAt?.toISOString() ?? null,
      loginLocked: Boolean(auth?.isBlocked),
      counts: {
        ...counts,
        reviewsReceived: reputation?.countedTotal ?? 0,
        // Null rather than 0 where nobody has reviewed them: a 0 average reads as "rated badly".
        ratingAverage: reputation && reputation.countedTotal > 0 ? reputation.average : null,
        reportsFiled,
        reportsReceived,
        blocksReceived,
      },
      pinnedNotes,
      openCases,
      suggestSuspension: activeStrikes >= threshold,
    };
  }

  /**
   * The plaintext of specific contact fields, for one member, once (S8.2).
   *
   * The audit entry records which fields were asked for and never the values — an audit trail that
   * stored the plaintext would be a second copy of everybody's contact details in a table that is
   * deliberately never deleted. `Cache-Control: no-store` is set by the admin middleware for the
   * whole surface, which is why it is not set again here.
   */
  async reveal(
    id: string,
    dto: RevealMemberDto,
  ): Promise<{
    data: {
      email?: string;
      phone?: string | null;
      dateOfBirth?: string | null;
      ips?: Record<string, string>;
    };
    auditId: string;
  }> {
    const member = await this.memberOrFail(id);
    const reason = dto.assertReasoned();
    const fields = [...new Set(dto.fields)];

    const sessions = fields.includes('ip')
      ? await this.database.userSession.findMany({
          where: { userId: id, ...(dto.sessionId ? { id: dto.sessionId } : {}) },
          select: { id: true, ipAddress: true },
          orderBy: { lastActiveAt: 'desc' },
          take: 50,
        })
      : [];

    if (fields.includes('ip') && dto.sessionId && !sessions.length) {
      throw ApiException.notFound('No such session.');
    }

    const data: {
      email?: string;
      phone?: string | null;
      dateOfBirth?: string | null;
      ips?: Record<string, string>;
    } = {};

    if (fields.includes('email')) data.email = member.email;

    if (fields.includes('phone')) {
      const code = member.profile?.phoneNumberDiallingCode ?? '';
      const number = member.profile?.phoneNumber ?? null;

      data.phone = number ? `${code}${number}` : null;
    }

    if (fields.includes('dateOfBirth')) {
      data.dateOfBirth = member.profile?.dateOfBirth?.toISOString().slice(0, 10) ?? null;
    }

    if (fields.includes('ip')) {
      data.ips = Object.fromEntries(sessions.map(session => [session.id, session.ipAddress]));
    }

    const auditId = await this.audit.record(this.database, {
      action: 'member.pii_reveal',
      targetType: 'MEMBER',
      targetId: id,
      reasonCode: reason.reasonCode,
      policySubtype: reason.policySubtype,
      reason: reason.note,
      metadata: {
        fields,
        ...(dto.sessionId ? { sessionId: dto.sessionId } : {}),
        ...(fields.includes('ip') ? { sessionCount: sessions.length } : {}),
      },
    });

    return { data, auditId };
  }

  /** Sessions, with the IP reduced to its /24 (S8.1). */
  async sessions(id: string) {
    await this.memberOrFail(id);

    const sessions = await this.database.userSession.findMany({
      where: { userId: id },
      orderBy: { lastActiveAt: 'desc' },
      take: 50,
    });

    return sessions.map(session => ({
      id: session.id,
      deviceType: session.deviceType,
      os: session.operatingSystem,
      browser: session.browserName,
      platform: session.platform,
      appVersion: session.appVersion,
      ipMasked: maskIp(session.ipAddress),
      isActive: session.isActive && !session.revokedAt,
      createdAt: session.createdAt.toISOString(),
      lastActiveAt: session.lastActiveAt.toISOString(),
      revokedAt: session.revokedAt?.toISOString() ?? null,
    }));
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * The member, or a 404 — which is also the answer for a staff account (R5) and an anonymised one.
   *
   * Staff are managed through Team and must not be reachable here; an anonymised account has no
   * personal data left to show, and serving an empty husk of one invites somebody to act on it.
   * Both are 404 rather than 403, because a 403 confirms the id belongs to somebody.
   */
  private async memberOrFail(id: string): Promise<AdminMemberSource> {
    const member = await this.database.user.findFirst({
      where: { id, isStaff: false, isAnonymised: false, deletedAt: null },
      select: AdminMemberService.SELECT,
    });

    if (!member) throw ApiException.notFound('No such member.');

    return member;
  }

  private static readonly SELECT = {
    id: true,
    firstName: true,
    lastName: true,
    username: true,
    avatarKey: true,
    profileImageUrl: true,
    email: true,
    status: true,
    suspendedUntil: true,
    signupMethod: true,
    lastPlatform: true,
    lastAppVersion: true,
    isAnonymised: true,
    createdAt: true,
    lastActiveAt: true,
    profile: {
      select: {
        gender: true,
        dateOfBirth: true,
        countryOfOriginCode: true,
        journeyStage: true,
        onboardingCompleted: true,
        phoneNumberDiallingCode: true,
        phoneNumber: true,
        headline: true,
        city: { select: { id: true, name: true, region: true } },
      },
    },
    professionalListing: { select: { id: true } },
    connectProfile: { select: { id: true } },
    store: { select: { id: true } },
  } satisfies Prisma.UserSelect;

  /** The total on its own, for the one case the windowed count cannot answer: an empty page. */
  private async countMatching(where: Prisma.Sql): Promise<number> {
    const [row] = await this.database.$queryRaw<Array<{ total: bigint }>>`
      SELECT COUNT(*) AS total
      FROM "users" u
      LEFT JOIN "user_profile" p ON p."user_id" = u."id"
      WHERE ${where}
    `;

    return Number(row?.total ?? 0);
  }

  /** The page's rows, keyed by id, so the SQL order can be preserved. */
  private async sourcesFor(ids: string[]): Promise<Map<string, AdminMemberSource>> {
    if (!ids.length) return new Map();

    const rows = await this.database.user.findMany({
      where: { id: { in: ids } },
      select: AdminMemberService.SELECT,
    });

    return new Map(rows.map(row => [row.id, row]));
  }

  /** The vocabularies a row is serialised against, loaded once per request. */
  private async context(at?: string): Promise<AdminMemberContext> {
    const [bands, journeyStageLabels] = await Promise.all([
      this.taxonomy.list(TaxonomyKind.CONNECT_AGE_BAND, false),
      this.taxonomy.labels(TaxonomyKind.JOURNEY_STAGE),
    ]);

    return {
      sign: (key: string) => this.media.sign(key),
      ageBands: bands
        .map(term => {
          const metadata = (term.metadata ?? {}) as { minAge?: number; maxAge?: number | null };

          return typeof metadata.minAge === 'number'
            ? { code: term.code, minAge: metadata.minAge, maxAge: metadata.maxAge ?? null }
            : null;
        })
        .filter((band): band is AgeBand => band !== null),
      journeyStageLabels,
      at: at ? londonMidnight(shiftDateOnly(at, 1)) : undefined,
    };
  }

  /**
   * `q`, as a predicate — or `'DENIED'` where it is an email and the caller may not match one.
   *
   * An exact id and an exact email are exact; a name is a trigram `ILIKE` against first name, last
   * name, username and the two names joined, because a staff member typing "ama o" is looking for
   * one person and should not have to know which column holds which half.
   */
  private searchPredicate(actor: AdminPrincipal, q?: string): Prisma.Sql | null | 'DENIED' {
    const term = q?.trim();

    if (!term) return null;

    if (UUID.test(term)) return Prisma.sql`u."id" = ${term}`;

    if (LOOKS_LIKE_EMAIL.test(term)) {
      if (!actor.permissions.has('members:pii_reveal')) return 'DENIED';

      return Prisma.sql`lower(u."email") = lower(${term})`;
    }

    const like = `%${term}%`;

    return Prisma.sql`(
      u."first_name" ILIKE ${like}
      OR u."last_name" ILIKE ${like}
      OR u."username" ILIKE ${like}
      OR (u."first_name" || ' ' || COALESCE(u."last_name", '')) ILIKE ${like}
    )`;
  }

  /** The list's own filters, which are not part of the shared member filter. */
  private listPredicates(dto: ListMembersDto, now: Date): Prisma.Sql[] {
    const predicates: Prisma.Sql[] = [];

    if (dto.hasStrikes !== undefined) {
      const live = Prisma.sql`EXISTS (
        SELECT 1 FROM "strikes" s
        WHERE s."user_id" = u."id" AND s."revoked_at" IS NULL AND s."expires_at" > ${now}
      )`;

      predicates.push(dto.hasStrikes ? live : Prisma.sql`NOT ${live}`);
    }

    if (dto.lastActiveFrom) {
      predicates.push(Prisma.sql`u."last_active_at" >= ${londonMidnight(dto.lastActiveFrom)}`);
    }

    if (dto.lastActiveTo) {
      predicates.push(
        Prisma.sql`u."last_active_at" < ${londonMidnight(shiftDateOnly(dto.lastActiveTo, 1))}`,
      );
    }

    if (dto.hasSection?.length) {
      // Any of them, not all: "members with a shop or a listing" is the question the chips ask.
      const sections = dto.hasSection.map(section =>
        section === 'PROFESSIONAL'
          ? Prisma.sql`EXISTS (SELECT 1 FROM "professional_listings" pl WHERE pl."user_id" = u."id")`
          : section === 'CONNECT'
            ? Prisma.sql`EXISTS (SELECT 1 FROM "connect_profiles" cp WHERE cp."user_id" = u."id")`
            : Prisma.sql`EXISTS (SELECT 1 FROM "stores" st WHERE st."owner_id" = u."id")`,
      );

      predicates.push(Prisma.sql`(${Prisma.join(sections, ' OR ')})`);
    }

    return predicates;
  }

  /**
   * `ORDER BY`, from an allowlist — never from the request.
   *
   * `sortField` has already refused anything not on the list, so this is the second half of the
   * same guarantee: the only strings that reach `Prisma.raw` are the ones written here.
   */
  private orderBy(sort: MemberSort, order: 'asc' | 'desc'): Prisma.Sql {
    const direction = order === 'asc' ? 'ASC' : 'DESC';
    // Nulls last in both directions: a member who has never been active is not the most recently
    // active one, and is not the least interesting either way round.
    const column =
      sort === 'createdAt'
        ? `u."created_at" ${direction}`
        : sort === 'lastActiveAt'
          ? `u."last_active_at" ${direction} NULLS LAST`
          : sort === 'name'
            ? `u."first_name" ${direction}, u."last_name" ${direction} NULLS LAST`
            : sort === 'strikes'
              ? `active_strikes ${direction}`
              : `reports_received ${direction}`;

    // `u."id"` last, always: two members created in the same millisecond would otherwise swap
    // places between pages and one of them would never be shown.
    return Prisma.raw(`${column}, u."id" ASC`);
  }

  /** What they have made. One query per section, run together. */
  private async contentCounts(id: string): Promise<{
    requests: number;
    offers: number;
    posts: number;
    replies: number;
    guides: number;
    groups: number;
    deals: number;
  }> {
    const [requests, offers, posts, replies, guides, groups, deals] = await Promise.all([
      this.database.communityRequest.count({ where: { authorId: id, deletedAt: null } }),
      this.database.communityOffer.count({ where: { authorId: id, deletedAt: null } }),
      this.database.communityUpdate.count({ where: { authorId: id, deletedAt: null } }),
      this.database.requestResponse.count({ where: { authorId: id, deletedAt: null } }),
      this.database.guide.count({ where: { authorId: id, deletedAt: null } }),
      this.database.groupMembership.count({ where: { userId: id } }),
      this.database.deal.count({ where: { OR: [{ payerId: id }, { providerId: id }] } }),
    ]);

    return { requests, offers, posts, replies, guides, groups, deals };
  }

  /**
   * How many open cases involve this member, by kind.
   *
   * Report cases, support threads and escalations have no tables yet — they arrive with their own
   * sections. `reports` counts the raw reports about them that nobody has closed, which is the same
   * question one layer down, and the two unbuilt counts are zero rather than absent so the portal's
   * four badges can be drawn now and become true without a contract change.
   */
  private async openCases(
    id: string,
  ): Promise<{ reports: number; guard: number; support: number; disputes: number }> {
    const [reports, guard, disputes] = await Promise.all([
      this.database.report.count({
        where: { targetUserId: id, state: { in: ['RECEIVED', 'TRIAGED'] } },
      }),
      this.database.guardThread.count({
        where: { userId: id, state: { in: ['OPEN', 'IN_PROGRESS'] } },
      }),
      this.database.dispute.count({
        where: { raisedById: id, state: { in: ['OPEN', 'IN_REVIEW'] } },
      }),
    ]);

    return { reports, guard, support: 0, disputes };
  }
}
