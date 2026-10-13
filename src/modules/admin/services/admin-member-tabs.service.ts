import { Injectable } from '@nestjs/common';
import {
  ConnectionRequestState,
  Prisma,
  ReportTargetType,
  SupportThreadType,
  TaxonomyKind,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { AdminPageOptionsDto, ApiErrorCode, ApiException, PageMeta, buildPageMeta } from '@/common';
import { CityService, MediaService, TaxonomyService } from '@/modules/platform/shared';
import { AdminPrincipal } from '../common/admin-principal';
import { AdminPolicyService } from '../common/admin-policy.service';
import { editableFieldsFor } from '../common/member-editable-fields';
import {
  ACTIVITY_TYPES,
  ActivityType,
  MemberActivityQueryDto,
  MemberContentQueryDto,
  MemberReportsQueryDto,
  MemberReviewsQueryDto,
} from '../dtos/admin-member-tabs.dto';
import { AuditEntryView, auditScopeFor, toAuditEntry } from '../serializers/audit-entry.serializer';
import { contentAdminUrl } from '../serializers/admin-url';
import {
  AgeBand,
  MemberRefView,
  ageBandOf,
  toMemberRef,
} from '../serializers/admin-member.serializer';
import { maskEmail, maskPhone } from '../serializers/pii.serializer';
import { staffRefSelect, toStaffRef } from '../serializers/admin-staff.serializer';

type Paged<T> = { data: T[]; meta: PageMeta };

export interface ActivityItemView {
  id: string;
  type: ActivityType;
  label: string;
  detail: string | null;
  occurredAt: string;
  /** Portal-relative, or null where the thing has no page of its own. */
  href: string | null;
}

export interface MemberContentItemView {
  targetType: ReportTargetType;
  targetId: string;
  title: string | null;
  excerpt: string | null;
  visibility: string | null;
  visibilityState: string;
  deletedAt: string | null;
  createdAt: string;
  adminUrl: string | null;
  risk: { tier: string; category: string | null } | null;
}

export interface ThreadSummaryView {
  conversationId: string;
  kind: string;
  contextType: string | null;
  counterpart: MemberRefView[];
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
  isSupport: boolean;
  hasOpenReport: boolean;
}

export interface DealSummaryView {
  id: string;
  track: string;
  role: 'PAYER' | 'PROVIDER';
  counterpart: MemberRefView;
  amountPence: number;
  stage: string;
  isCancelled: boolean;
  hasProblem: boolean;
  createdAt: string;
}

export interface MemberReportRowView {
  id: string;
  direction: 'filed' | 'received';
  counterpart: MemberRefView | null;
  targetType: ReportTargetType;
  reasonCode: string;
  state: string;
  decision: string | null;
  createdAt: string;
}

export interface AdminReviewView {
  id: string;
  direction: 'given' | 'received';
  counterpart: MemberRefView;
  rating: number;
  context: string;
  comment: string | null;
  countsToAverage: boolean;
  createdAt: string;
}

export interface MemberGroupRowView {
  group: { id: string; name: string; city: string | null };
  state: string;
  isAdmin: boolean;
  joinedAt: string | null;
  requestedAt: string;
}

export interface LinkableCaseView {
  type: 'REPORT_CASE' | 'SUPPORT_THREAD' | 'GUARD_CASE' | 'DISPUTE' | 'ESCALATION' | 'QUEUE_ITEM';
  id: string;
  label: string;
  createdAt: string;
}

export interface MemberBlocksView {
  blockedBy: number;
  blocking: number;
  recent: Array<{
    member: MemberRefView;
    direction: 'BLOCKED_BY' | 'BLOCKING';
    createdAt: string;
  }>;
}

/**
 * What a timeline row says, in words.
 *
 * Built here rather than concatenated in SQL so that rewording a label is a code change and not a
 * migration, and so a row whose shape nobody anticipated falls back to its own type name instead of
 * rendering as `null null`.
 */
const ACTIVITY_LABELS: Record<
  string,
  (primary: string | null, secondary: string | null) => string
> = {
  SIGNUP: method => `Joined Circl${method ? ` with ${method.toLowerCase()}` : ''}`,
  LOGIN: platform => `Signed in${platform ? ` on ${platform.toLowerCase()}` : ''}`,
  CREATE: subject => `Posted a ${(subject ?? 'item').toLowerCase().replace(/_/g, ' ')}`,
  RESPOND: subject => `Replied to a ${(subject ?? 'post').toLowerCase().replace(/_/g, ' ')}`,
  JOIN: subject => `Joined a ${(subject ?? 'group').toLowerCase().replace(/_/g, ' ')}`,
  ENQUIRE: subject => `Enquired about a ${(subject ?? 'listing').toLowerCase().replace(/_/g, ' ')}`,
  BOOK: subject => `Booked a ${(subject ?? 'service').toLowerCase().replace(/_/g, ' ')}`,
  REPORT_FILED: reason => `Reported something${reason ? ` as ${reason.toLowerCase()}` : ''}`,
  REPORTED: reason => `Was reported${reason ? ` for ${reason.toLowerCase()}` : ''}`,
  ENFORCEMENT: kind => (kind === 'SUSPENSION' ? 'Account suspended' : 'Strike issued'),
  PROFILE_EDIT: () => 'Profile edited by staff',
};

/** The columns a `MemberRef` needs, wherever a tab names somebody other than the member. */
const memberRefSelect = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  avatarKey: true,
  profileImageUrl: true,
  status: true,
  isAnonymised: true,
} as const;

/**
 * The content a member authors, as one list.
 *
 * **Every arm aliases every column.** A `UNION ALL` takes its column names from whichever arm comes
 * first, and `targetType` filters the arms — so with positional columns the query worked only while
 * the one arm that happened to name them was included, and `?targetType=GUIDE` failed with "column
 * c.target_type does not exist". The same rule applies to the timeline below, for the same reason.
 *
 * Nine tables with nine shapes, paged together by date — which is the only order a staff member
 * asking "what has this person posted" can use. A `UNION ALL` rather than nine queries merged in
 * memory: merging in memory means reading every row of all nine to show twenty-five of them, and
 * the count at the bottom of the page would be a lie or a tenth query.
 *
 * Each arm names its own `ReportTargetType`, so a row knows what it is without the caller having to
 * remember which arm produced it, and `excerpt` is truncated in SQL rather than afterwards — a
 * member with four hundred long posts should not move four hundred long posts across the wire to
 * show twenty-five snippets.
 */
/**
 * One definition of "a piece of content", answering two questions.
 *
 * The member content tab asks "what has this member written" and the command palette asks
 * "what is the thing with this id". Both have to cover the same eleven tables, and a second
 * list of eleven would drift the first time one of them gained a column — so each arm carries
 * its shape plus the two columns a caller might filter on, and the caller supplies the
 * predicate.
 */
const CONTENT_ARMS: Array<{
  type: ReportTargetType;
  /** The SELECT and its joins, up to but not including the WHERE. */
  body: Prisma.Sql;
  /** The column holding the author's user id, which is not always on the arm's own table. */
  author: Prisma.Sql;
  /** The column holding the content's own id. */
  id: Prisma.Sql;
}> = [
  {
    type: ReportTargetType.REQUEST,
    body: Prisma.sql`
      SELECT 'REQUEST' AS target_type, r."id" AS id, r."title" AS title,
             LEFT(COALESCE(r."description", ''), 280) AS excerpt,
             r."visibility"::text AS visibility, r."deleted_at" AS deleted_at,
             r."created_at" AS created_at
      FROM "community_requests" r`,
    author: Prisma.sql`r."author_id"`,
    id: Prisma.sql`r."id"`,
  },
  {
    type: ReportTargetType.OFFER,
    body: Prisma.sql`
      SELECT 'OFFER' AS target_type, o."id" AS id, o."title" AS title,
             LEFT(o."description", 280) AS excerpt,
             o."visibility"::text AS visibility, o."deleted_at" AS deleted_at,
             o."created_at" AS created_at
      FROM "community_offers" o`,
    author: Prisma.sql`o."author_id"`,
    id: Prisma.sql`o."id"`,
  },
  {
    type: ReportTargetType.UPDATE,
    body: Prisma.sql`
      SELECT 'UPDATE' AS target_type, u."id" AS id, NULL::text AS title,
             LEFT(u."content", 280) AS excerpt,
             u."visibility"::text AS visibility, u."deleted_at" AS deleted_at,
             u."created_at" AS created_at
      FROM "community_updates" u`,
    author: Prisma.sql`u."author_id"`,
    id: Prisma.sql`u."id"`,
  },
  {
    type: ReportTargetType.RESPONSE,
    body: Prisma.sql`
      SELECT 'RESPONSE' AS target_type, rr."id" AS id, NULL::text AS title,
             LEFT(rr."content", 280) AS excerpt,
             NULL::text AS visibility, rr."deleted_at" AS deleted_at,
             rr."created_at" AS created_at
      FROM "request_responses" rr`,
    author: Prisma.sql`rr."author_id"`,
    id: Prisma.sql`rr."id"`,
  },
  {
    type: ReportTargetType.UPDATE_REPLY,
    body: Prisma.sql`
      SELECT 'UPDATE_REPLY' AS target_type, ur."id" AS id, NULL::text AS title,
             LEFT(ur."content", 280) AS excerpt,
             NULL::text AS visibility, ur."deleted_at" AS deleted_at,
             ur."created_at" AS created_at
      FROM "update_replies" ur`,
    author: Prisma.sql`ur."author_id"`,
    id: Prisma.sql`ur."id"`,
  },
  {
    type: ReportTargetType.GUIDE,
    body: Prisma.sql`
      SELECT 'GUIDE' AS target_type, g."id" AS id, g."title" AS title,
             LEFT(g."intro", 280) AS excerpt,
             NULL::text AS visibility, g."deleted_at" AS deleted_at,
             g."created_at" AS created_at
      FROM "guides" g`,
    author: Prisma.sql`g."author_id"`,
    id: Prisma.sql`g."id"`,
  },
  {
    type: ReportTargetType.GROUP_POST,
    body: Prisma.sql`
      SELECT 'GROUP_POST' AS target_type, gp."id" AS id, NULL::text AS title,
             LEFT(gp."content", 280) AS excerpt,
             NULL::text AS visibility, gp."deleted_at" AS deleted_at,
             gp."created_at" AS created_at
      FROM "group_posts" gp`,
    author: Prisma.sql`gp."author_id"`,
    id: Prisma.sql`gp."id"`,
  },
  {
    type: ReportTargetType.GROUP_POST_REPLY,
    body: Prisma.sql`
      SELECT 'GROUP_POST_REPLY' AS target_type, gr."id" AS id, NULL::text AS title,
             LEFT(gr."content", 280) AS excerpt,
             NULL::text AS visibility, gr."deleted_at" AS deleted_at,
             gr."created_at" AS created_at
      FROM "group_post_replies" gr`,
    author: Prisma.sql`gr."author_id"`,
    id: Prisma.sql`gr."id"`,
  },
  {
    type: ReportTargetType.CONNECT_MEDIA,
    body: Prisma.sql`
      SELECT 'CONNECT_MEDIA' AS target_type, cp."id" AS id, NULL::text AS title,
             LEFT(COALESCE(cp."caption", ''), 280) AS excerpt,
             NULL::text AS visibility, cp."deleted_at" AS deleted_at,
             cp."posted_at" AS created_at
      FROM "connect_posts" cp
      JOIN "connect_profiles" cpr ON cpr."id" = cp."profile_id"`,
    author: Prisma.sql`cpr."user_id"`,
    id: Prisma.sql`cp."id"`,
  },
  {
    type: ReportTargetType.CONNECT_STORY,
    body: Prisma.sql`
      SELECT 'CONNECT_STORY' AS target_type, cs."id" AS id, NULL::text AS title,
             LEFT(COALESCE(cs."caption", ''), 280) AS excerpt,
             NULL::text AS visibility, cs."deleted_at" AS deleted_at,
             cs."posted_at" AS created_at
      FROM "connect_stories" cs`,
    author: Prisma.sql`cs."user_id"`,
    id: Prisma.sql`cs."id"`,
  },
  {
    type: ReportTargetType.STORE_ITEM,
    body: Prisma.sql`
      SELECT 'STORE_ITEM' AS target_type, si."id" AS id, si."name" AS title,
             LEFT(COALESCE(si."description", ''), 280) AS excerpt,
             NULL::text AS visibility, si."deleted_at" AS deleted_at,
             si."created_at" AS created_at
      FROM "store_items" si
      JOIN "stores" st ON st."id" = si."store_id"`,
    author: Prisma.sql`st."owner_id"`,
    id: Prisma.sql`si."id"`,
  },
];

/** This member's content, which is what the content tab lists. */
export const contentByAuthor = (
  userId: string,
): Array<{ type: ReportTargetType; sql: Prisma.Sql }> =>
  CONTENT_ARMS.map(arm => ({
    type: arm.type,
    sql: Prisma.sql`${arm.body} WHERE ${arm.author} = ${userId}`,
  }));

/**
 * The content with this id, whatever kind it is.
 *
 * Every arm is asked, because an id does not say what it belongs to. Eleven indexed primary-key
 * lookups is a cheap way to answer that, and far cheaper than making the caller guess the type.
 */
export const contentById = (
  contentId: string,
): Array<{ type: ReportTargetType; sql: Prisma.Sql }> =>
  CONTENT_ARMS.map(arm => ({
    type: arm.type,
    sql: Prisma.sql`${arm.body} WHERE ${arm.id} = ${contentId}`,
  }));

@Injectable()
export class AdminMemberTabsService {
  constructor(
    private readonly database: PrismaService,
    private readonly media: MediaService,
    private readonly taxonomy: TaxonomyService,
    private readonly policy: AdminPolicyService,
    // For city **names** on the sections tab, which showed ids.
    private readonly cities: CityService,
  ) {}

  private get sign() {
    return (key: string) => this.media.sign(key);
  }

  // ─── Profile ───────────────────────────────────────────────────────────────

  /**
   * Every editable field, with the contact details masked and the caller's own allowlist attached.
   *
   * `editableFields` comes from the same map the `PATCH` enforces (S10.2), so the form the portal
   * draws and the fields the API accepts cannot drift. A form offering a field the API refuses is a
   * staff member typing a correction that silently never happens.
   */
  async profile(actor: AdminPrincipal, id: string) {
    await this.policy.assertIsMember(id);

    const member = await this.database.user.findUniqueOrThrow({
      where: { id },
      select: {
        firstName: true,
        lastName: true,
        username: true,
        email: true,
        avatarKey: true,
        profileImageUrl: true,
        profile: {
          select: {
            cityId: true,
            gender: true,
            dateOfBirth: true,
            countryOfOriginCode: true,
            heritageTag: true,
            journeyStage: true,
            languages: true,
            interests: true,
            headline: true,
            bio: true,
            canHelpWith: true,
            phoneNumberDiallingCode: true,
            phoneNumber: true,
          },
        },
      },
    });

    const bands = await this.ageBands();

    return {
      firstName: member.firstName,
      lastName: member.lastName,
      username: member.username,
      emailMasked: maskEmail(member.email),
      phoneMasked: maskPhone(member.profile?.phoneNumberDiallingCode, member.profile?.phoneNumber),
      // The dialling code is not a contact detail on its own — it is a country — so it is shown
      // while the number it belongs to is masked. A staff member needs it to know which number
      // format the rest should be in.
      phoneNumberDiallingCode: member.profile?.phoneNumberDiallingCode ?? null,
      avatarUrl: member.avatarKey ? this.sign(member.avatarKey) : member.profileImageUrl,
      cityId: member.profile?.cityId ?? null,
      gender: member.profile?.gender ?? null,
      // Never the date itself (S8.1) — `reveal` serves that, and records who looked.
      ageBand: ageBandOf(member.profile?.dateOfBirth ?? null, bands),
      dateOfBirthSet: Boolean(member.profile?.dateOfBirth),
      countryOfOriginCode: member.profile?.countryOfOriginCode ?? null,
      heritageTag: member.profile?.heritageTag ?? null,
      journeyStage: member.profile?.journeyStage ?? null,
      languages: this.codeList(member.profile?.languages),
      interests: this.codeList(member.profile?.interests),
      headline: member.profile?.headline ?? null,
      bio: member.profile?.bio ?? null,
      canHelpWith: member.profile?.canHelpWith ?? null,
      editableFields: editableFieldsFor(actor.roleCode),
    };
  }

  // ─── Sections ──────────────────────────────────────────────────────────────

  /** What the member has in each part of the platform, or null where they are not in it. */
  async sections(id: string) {
    await this.policy.assertIsMember(id);

    const [requests, offers, posts, groups, guidesRead, listing, connect, store, reputation] =
      await Promise.all([
        this.database.communityRequest.count({ where: { authorId: id, deletedAt: null } }),
        this.database.communityOffer.count({ where: { authorId: id, deletedAt: null } }),
        this.database.communityUpdate.count({ where: { authorId: id, deletedAt: null } }),
        this.database.groupMembership.count({ where: { userId: id, state: 'MEMBER' } }),
        this.database.guideProgress.count({ where: { userId: id } }),
        this.database.professionalListing.findUnique({
          where: { userId: id },
          select: {
            id: true,
            professionTitle: true,
            verificationStatus: true,
            isAcceptingWork: true,
            jobsCompleted: true,
            medianResponseMinutes: true,
            cityId: true,
          },
        }),
        this.database.connectProfile.findUnique({
          where: { userId: id },
          select: {
            id: true,
            typeCode: true,
            dmPolicy: true,
            isVisible: true,
            datingConfirmedAt: true,
          },
        }),
        this.database.store.findUnique({
          where: { ownerId: id },
          select: {
            id: true,
            name: true,
            typeCode: true,
            status: true,
            complianceState: true,
            cityId: true,
          },
        }),
        this.database.reputationSummary.findUnique({ where: { userId: id } }),
      ]);

    const [connectPosts, connectStories, connections, storeItems, storeEnquiries] =
      await Promise.all([
        connect
          ? this.database.connectPost.count({ where: { profileId: connect.id, deletedAt: null } })
          : 0,
        connect ? this.database.connectStory.count({ where: { userId: id, deletedAt: null } }) : 0,
        connect
          ? this.database.connectionRequest.count({
              where: {
                state: ConnectionRequestState.ACCEPTED,
                OR: [{ fromUserId: id }, { toUserId: id }],
              },
            })
          : 0,
        store
          ? this.database.storeItem.count({ where: { storeId: store.id, deletedAt: null } })
          : 0,
        store ? this.database.enquiry.count({ where: { sellerId: id } }) : 0,
      ]);

    // The rating is the member's, not the listing's: `ProfessionalListing.ratingScore` is a ranking
    // score built for ordering browse results, and reading it as an average would put a number
    // next to a star that does not mean what the star means.
    const ratingAverage = reputation && reputation.countedTotal > 0 ? reputation.average : null;

    // City **names**, not ids. These two read `LONDON` straight out of the column, so the member
    // page showed a code where every other surface shows "London" — and the portal has no city
    // list to resolve it against on that screen.
    const cityNameOf = async (cityId: string | null): Promise<string | null> =>
      cityId ? ((await this.cities.find(cityId))?.name ?? cityId) : null;
    const [listingCity, storeCity] = await Promise.all([
      cityNameOf(listing?.cityId ?? null),
      cityNameOf(store?.cityId ?? null),
    ]);

    return {
      community: { requests, offers, posts, groups, guidesRead },
      professional: listing
        ? {
            listingId: listing.id,
            professionTitle: listing.professionTitle,
            verificationStatus: listing.verificationStatus,
            isAcceptingWork: listing.isAcceptingWork,
            ratingAverage,
            jobsCompleted: listing.jobsCompleted,
            medianResponseMinutes: listing.medianResponseMinutes,
            city: listingCity,
          }
        : null,
      connect: connect
        ? {
            connectionType: connect.typeCode,
            dmPolicy: connect.dmPolicy,
            isVisible: connect.isVisible,
            posts: connectPosts,
            stories: connectStories,
            connections,
            datingConfirmed: Boolean(connect.datingConfirmedAt),
          }
        : null,
      store: store
        ? {
            id: store.id,
            name: store.name,
            type: store.typeCode,
            status: store.status,
            complianceState: store.complianceState,
            items: storeItems,
            enquiries: storeEnquiries,
            city: storeCity,
          }
        : null,
    };
  }

  // ─── Activity ──────────────────────────────────────────────────────────────

  /**
   * One timeline, from seven sources.
   *
   * The activity stream holds what a member did deliberately; it does not hold their sign-up, their
   * sign-ins, the reports they filed or what was done to them — and those are exactly the events a
   * staff member reading an account wants in date order beside the rest. So they are unioned at
   * query time rather than written twice.
   *
   * `types` filters by dropping whole arms, which makes the filter cheaper than the unfiltered
   * query rather than more expensive.
   */
  async activity(id: string, dto: MemberActivityQueryDto): Promise<Paged<ActivityItemView>> {
    await this.policy.assertIsMember(id);
    dto.assertDepth();

    const wanted = new Set<ActivityType>(dto.types?.length ? dto.types : ACTIVITY_TYPES);
    const arms: Prisma.Sql[] = [];

    if (wanted.has('SIGNUP')) {
      arms.push(Prisma.sql`
        SELECT 'SIGNUP' AS kind, u."created_at" AS occurred_at,
               u."signup_method"::text AS primary_value, NULL AS secondary_value,
               NULL AS target_type, NULL AS target_id
        FROM "users" u WHERE u."id" = ${id}`);
    }

    if (wanted.has('LOGIN')) {
      arms.push(Prisma.sql`
        SELECT 'LOGIN' AS kind, s."created_at" AS occurred_at, s."platform"::text AS primary_value,
               s."operating_system" AS secondary_value,
               NULL::text AS target_type, NULL::text AS target_id
        FROM "user_sessions" s WHERE s."user_id" = ${id}`);
    }

    // The stream's own verbs, which map one-to-one onto the item types.
    const verbs = (['CREATE', 'RESPOND', 'JOIN', 'ENQUIRE', 'BOOK'] as const).filter(verb =>
      wanted.has(verb),
    );

    if (verbs.length) {
      arms.push(Prisma.sql`
        SELECT ae."verb"::text AS kind, ae."occurred_at" AS occurred_at,
               ae."subject"::text AS primary_value, ae."code" AS secondary_value,
               ae."subject"::text AS target_type, ae."subject_id" AS target_id
        FROM "activity_events" ae
        WHERE ae."user_id" = ${id} AND ae."verb"::text IN (${Prisma.join(verbs)})`);
    }

    if (wanted.has('REPORT_FILED')) {
      arms.push(Prisma.sql`
        SELECT 'REPORT_FILED' AS kind, r."created_at" AS occurred_at,
               r."reason_code"::text AS primary_value, r."target_type"::text AS secondary_value,
               r."target_type"::text AS target_type, r."target_id" AS target_id
        FROM "reports" r WHERE r."reporter_id" = ${id}`);
    }

    if (wanted.has('REPORTED')) {
      arms.push(Prisma.sql`
        SELECT 'REPORTED' AS kind, r."created_at" AS occurred_at,
               r."reason_code"::text AS primary_value, r."target_type"::text AS secondary_value,
               r."target_type"::text AS target_type, r."target_id" AS target_id
        FROM "reports" r WHERE r."target_user_id" = ${id}`);
    }

    if (wanted.has('ENFORCEMENT')) {
      arms.push(Prisma.sql`
        SELECT 'ENFORCEMENT' AS kind, s."issued_at" AS occurred_at, 'STRIKE' AS primary_value,
               s."reason_code"::text AS secondary_value,
               NULL::text AS target_type, s."id" AS target_id
        FROM "strikes" s WHERE s."user_id" = ${id}`);
      arms.push(Prisma.sql`
        SELECT 'ENFORCEMENT' AS kind, sp."created_at" AS occurred_at, 'SUSPENSION' AS primary_value,
               sp."reason_code"::text AS secondary_value,
               NULL::text AS target_type, sp."id" AS target_id
        FROM "suspensions" sp WHERE sp."user_id" = ${id}`);
    }

    if (wanted.has('PROFILE_EDIT')) {
      // Staff edits only. A member's own profile saves are not recorded anywhere — `updated_at` is
      // one timestamp, not a history — so this arm is honestly "what we changed", not "what
      // changed". Worth knowing when reading an account: a field that looks wrong may have been
      // corrected by us rather than set by them.
      arms.push(Prisma.sql`
        SELECT 'PROFILE_EDIT' AS kind, a."occurred_at" AS occurred_at, a."action" AS primary_value,
               a."reason_code"::text AS secondary_value,
               'MEMBER' AS target_type, a."target_id" AS target_id
        FROM "audit_logs" a
        WHERE a."target_type" = 'MEMBER' AND a."target_id" = ${id} AND a."action" = 'member.updated'`);
    }

    if (!arms.length) return { data: [], meta: this.page(dto, 0) };

    const offset = (dto.currentPage - 1) * dto.size;
    const rows = await this.database.$queryRaw<
      Array<{
        kind: string;
        occurred_at: Date;
        primary_value: string | null;
        secondary_value: string | null;
        target_type: string | null;
        target_id: string | null;
        total: bigint;
      }>
    >`
      WITH timeline AS (${Prisma.join(arms, ' UNION ALL ')})
      SELECT *, COUNT(*) OVER () AS total
      FROM timeline
      ORDER BY occurred_at DESC
      LIMIT ${dto.size} OFFSET ${offset}
    `;

    const total = rows.length ? Number(rows[0].total) : await this.countTimeline(arms);

    return {
      data: rows.map(row => this.toActivityItem(row)),
      meta: this.page(dto, total),
    };
  }

  private async countTimeline(arms: Prisma.Sql[]): Promise<number> {
    const [row] = await this.database.$queryRaw<Array<{ total: bigint }>>`
      WITH timeline AS (${Prisma.join(arms, ' UNION ALL ')})
      SELECT COUNT(*) AS total FROM timeline
    `;

    return Number(row?.total ?? 0);
  }

  /** The sentence a staff member reads, built here rather than concatenated in SQL. */
  private toActivityItem(row: {
    kind: string;
    occurred_at: Date;
    primary_value: string | null;
    secondary_value: string | null;
    target_type: string | null;
    target_id: string | null;
  }): ActivityItemView {
    const label = ACTIVITY_LABELS[row.kind]?.(row.primary_value, row.secondary_value) ?? row.kind;

    return {
      // No stable id of its own: a timeline row is a projection of seven tables, and inventing a
      // composite key would imply something the portal could fetch again on its own.
      id: `${row.kind}:${row.target_id ?? row.occurred_at.getTime()}`,
      type: row.kind as ActivityType,
      label,
      detail: row.secondary_value,
      occurredAt: row.occurred_at.toISOString(),
      href:
        row.target_type && row.target_id
          ? contentAdminUrl(row.target_type as ReportTargetType, row.target_id)
          : null,
    };
  }

  // ─── Content ───────────────────────────────────────────────────────────────

  /**
   * Everything the member has authored, newest first, with whatever Guard knows about it.
   *
   * `visibilityState` is derived from the moderation queue rather than read from a column, because
   * the per-content safety table (§4.5) has not shipped. Two of the five states are reachable
   * today — `PENDING_APPROVAL` for a live anonymous-post item and `VISIBLE` for everything else;
   * filtering by `LIMITED`, `HELD` or `REJECTED` therefore matches nothing until it does. Derived
   * in SQL and not afterwards, so the filter, the page and the count agree.
   */
  async content(id: string, dto: MemberContentQueryDto): Promise<Paged<MemberContentItemView>> {
    await this.policy.assertIsMember(id);
    dto.assertDepth();

    const arms = contentByAuthor(id)
      .filter(arm => !dto.targetType || arm.type === dto.targetType)
      .map(arm => arm.sql);

    if (!arms.length) return { data: [], meta: this.page(dto, 0) };

    const offset = (dto.currentPage - 1) * dto.size;
    const state = dto.visibilityState
      ? Prisma.sql`WHERE visibility_state = ${dto.visibilityState}`
      : Prisma.empty;

    const rows = await this.database.$queryRaw<
      Array<{
        target_type: ReportTargetType;
        id: string;
        title: string | null;
        excerpt: string | null;
        visibility: string | null;
        deleted_at: Date | null;
        created_at: Date;
        visibility_state: string;
        risk_level: string | null;
        risk_category: string | null;
        total: bigint;
      }>
    >`
      WITH authored AS (${Prisma.join(arms, ' UNION ALL ')}),
      judged AS (
        SELECT c.*,
               CASE
                 WHEN q."type" = 'ANONYMOUS_POST' AND q."state" IN ('PENDING', 'IN_REVIEW')
                   THEN 'PENDING_APPROVAL'
                 ELSE 'VISIBLE'
               END AS visibility_state,
               q."risk_level"::text AS risk_level,
               q."risk_category"::text AS risk_category
        FROM authored c
        LEFT JOIN LATERAL (
          SELECT m."type", m."state", m."risk_level", m."risk_category"
          FROM "moderation_queue_items" m
          WHERE m."target_type"::text = c.target_type AND m."target_id" = c."id"
          ORDER BY m."created_at" DESC
          LIMIT 1
        ) q ON TRUE
      )
      SELECT *, COUNT(*) OVER () AS total
      FROM judged
      ${state}
      ORDER BY created_at DESC
      LIMIT ${dto.size} OFFSET ${offset}
    `;

    const total = rows.length ? Number(rows[0].total) : 0;

    return {
      data: rows.map(row => ({
        targetType: row.target_type,
        targetId: row.id,
        title: row.title,
        excerpt: row.excerpt || null,
        visibility: row.visibility,
        visibilityState: row.visibility_state,
        deletedAt: row.deleted_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
        adminUrl: contentAdminUrl(row.target_type, row.id),
        // Null where nothing has ever looked at it, which is most content and is not the same as
        // "looked at and found clean".
        risk: row.risk_level ? { tier: row.risk_level, category: row.risk_category } : null,
      })),
      meta: this.page(dto, total),
    };
  }

  // ─── Threads ───────────────────────────────────────────────────────────────

  /**
   * The member's conversations, as metadata only — never a message body (S9).
   *
   * Reading what two members said to each other needs an access grant tied to a case (§5.6), and
   * this list is what a staff member uses to decide which thread that grant should be for. So it
   * carries who, how many and when, and nothing of what.
   */
  async threads(id: string, dto: AdminPageOptionsDto): Promise<Paged<ThreadSummaryView>> {
    await this.policy.assertIsMember(id);
    dto.assertDepth();

    const where: Prisma.ConversationWhereInput = { participants: { some: { userId: id } } };
    const [total, rows] = await Promise.all([
      this.database.conversation.count({ where }),
      this.database.conversation.findMany({
        where,
        orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
        skip: (dto.currentPage - 1) * dto.size,
        take: dto.size,
        select: {
          id: true,
          kind: true,
          contextType: true,
          messageCount: true,
          lastMessageAt: true,
          createdAt: true,
          participants: {
            where: { userId: { not: id } },
            select: {
              user: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  username: true,
                  avatarKey: true,
                  profileImageUrl: true,
                  status: true,
                  isAnonymised: true,
                },
              },
            },
          },
        },
      }),
    ]);

    // One query for every thread on the page rather than one per thread: "does this thread have an
    // open report" is the flag that decides whether a staff member looks at it at all.
    const reported = new Set(
      (
        await this.database.report.findMany({
          where: {
            targetType: 'CONVERSATION',
            targetId: { in: rows.map(row => row.id) },
            state: { in: ['RECEIVED', 'TRIAGED'] },
          },
          select: { targetId: true },
        })
      ).map(report => report.targetId),
    );

    return {
      data: rows.map(row => ({
        conversationId: row.id,
        kind: row.kind,
        contextType: row.contextType,
        counterpart: row.participants
          .map(participant => participant.user)
          .filter((user): user is NonNullable<typeof user> => user !== null)
          .map(user => toMemberRef(user, this.sign)),
        messageCount: row.messageCount,
        lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        isSupport: row.kind === 'SUPPORT',
        hasOpenReport: reported.has(row.id),
      })),
      meta: this.page(dto, total),
    };
  }

  // ─── Deals ─────────────────────────────────────────────────────────────────

  /** Money they agreed, either side of it. */
  async deals(id: string, dto: AdminPageOptionsDto): Promise<Paged<DealSummaryView>> {
    await this.policy.assertIsMember(id);
    dto.assertDepth();

    const where: Prisma.DealWhereInput = { OR: [{ payerId: id }, { providerId: id }] };
    const [total, rows] = await Promise.all([
      this.database.deal.count({ where }),
      this.database.deal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (dto.currentPage - 1) * dto.size,
        take: dto.size,
        select: {
          id: true,
          track: true,
          payerId: true,
          providerId: true,
          amount: true,
          isCancelled: true,
          hasProblem: true,
          createdAt: true,
          payer: { select: memberRefSelect },
          provider: { select: memberRefSelect },
          steps: { select: { stage: true }, orderBy: { reachedAt: 'desc' }, take: 1 },
        },
      }),
    ]);

    return {
      data: rows.map(row => {
        const isPayer = row.payerId === id;

        return {
          id: row.id,
          track: row.track,
          role: isPayer ? ('PAYER' as const) : ('PROVIDER' as const),
          counterpart: toMemberRef(isPayer ? row.provider : row.payer, this.sign),
          amountPence: row.amount,
          // The furthest stage reached, or CANCELLED — which is a state rather than a stage, and
          // overrides whatever stage it had got to.
          stage: row.isCancelled ? 'CANCELLED' : (row.steps[0]?.stage ?? 'AGREED'),
          isCancelled: row.isCancelled,
          hasProblem: row.hasProblem,
          createdAt: row.createdAt.toISOString(),
        };
      }),
      meta: this.page(dto, total),
    };
  }

  // ─── Reports ───────────────────────────────────────────────────────────────

  /**
   * Reports this member filed, or reports about them.
   *
   * R9: a caller with `reports:read` but not `moderation:read` sees no counterpart on a *received*
   * report. Knowing somebody has been reported five times is support's business; knowing who
   * reported them is not, because that is the one fact that turns a report into a reprisal.
   */
  async reports(
    actor: AdminPrincipal,
    id: string,
    dto: MemberReportsQueryDto,
  ): Promise<Paged<MemberReportRowView>> {
    await this.policy.assertIsMember(id);
    dto.assertDepth();

    const direction = dto.direction ?? 'received';
    const where: Prisma.ReportWhereInput =
      direction === 'filed' ? { reporterId: id } : { targetUserId: id };
    const maySeeReporter = actor.permissions.has('moderation:read');

    const [total, rows] = await Promise.all([
      this.database.report.count({ where }),
      this.database.report.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (dto.currentPage - 1) * dto.size,
        take: dto.size,
        select: {
          id: true,
          targetType: true,
          reasonCode: true,
          state: true,
          decision: true,
          createdAt: true,
          reporter: { select: memberRefSelect },
          targetUser: { select: memberRefSelect },
        },
      }),
    ]);

    return {
      data: rows.map(row => {
        const other = direction === 'filed' ? row.targetUser : row.reporter;
        const hidden = direction === 'received' && !maySeeReporter;

        return {
          id: row.id,
          direction,
          counterpart: hidden || !other ? null : toMemberRef(other, this.sign),
          targetType: row.targetType,
          reasonCode: row.reasonCode,
          state: row.state,
          decision: row.decision,
          createdAt: row.createdAt.toISOString(),
        };
      }),
      meta: this.page(dto, total, {
        counterpartHidden: direction === 'received' && !maySeeReporter,
      }),
    };
  }

  // ─── Reviews ───────────────────────────────────────────────────────────────

  async reviews(id: string, dto: MemberReviewsQueryDto): Promise<Paged<AdminReviewView>> {
    await this.policy.assertIsMember(id);
    dto.assertDepth();

    const direction = dto.direction ?? 'received';
    const where: Prisma.ReviewWhereInput =
      direction === 'given' ? { reviewerId: id } : { subjectUserId: id };

    const [total, rows] = await Promise.all([
      this.database.review.count({ where }),
      this.database.review.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (dto.currentPage - 1) * dto.size,
        take: dto.size,
        select: {
          id: true,
          rating: true,
          context: true,
          comment: true,
          countsToAverage: true,
          createdAt: true,
          reviewer: { select: memberRefSelect },
          subjectUser: { select: memberRefSelect },
        },
      }),
    ]);

    return {
      data: rows.map(row => ({
        id: row.id,
        direction,
        counterpart: toMemberRef(direction === 'given' ? row.subjectUser : row.reviewer, this.sign),
        rating: row.rating,
        context: row.context,
        comment: row.comment,
        // Shown because a review excluded from the average is the interesting one: it is how a
        // reciprocal five-star pair or a review from a blocked member reads on the page.
        countsToAverage: row.countsToAverage,
        createdAt: row.createdAt.toISOString(),
      })),
      meta: this.page(dto, total),
    };
  }

  // ─── Groups ────────────────────────────────────────────────────────────────

  async groups(id: string, dto: AdminPageOptionsDto): Promise<Paged<MemberGroupRowView>> {
    await this.policy.assertIsMember(id);
    dto.assertDepth();

    const where: Prisma.GroupMembershipWhereInput = { userId: id };
    const [total, rows] = await Promise.all([
      this.database.groupMembership.count({ where }),
      this.database.groupMembership.findMany({
        where,
        orderBy: [{ joinedAt: 'desc' }, { requestedAt: 'desc' }],
        skip: (dto.currentPage - 1) * dto.size,
        take: dto.size,
        select: {
          state: true,
          isAdmin: true,
          joinedAt: true,
          requestedAt: true,
          group: { select: { id: true, name: true, cityId: true } },
        },
      }),
    ]);

    return {
      data: rows.map(row => ({
        group: { id: row.group.id, name: row.group.name, city: row.group.cityId },
        state: row.state,
        isAdmin: row.isAdmin,
        // Null where they are still waiting to be let in, which `requestedAt` answers instead.
        joinedAt: row.joinedAt?.toISOString() ?? null,
        requestedAt: row.requestedAt.toISOString(),
      })),
      meta: this.page(dto, total),
    };
  }

  // ─── Enforcement ───────────────────────────────────────────────────────────

  /**
   * What has been done to this account, and whether it still stands.
   *
   * `warnings` is not a fourth table: it is the strikes the member was actually **told** about
   * (§13.1). A strike with no `notifiedAt` is a recorded breach nobody informed them of, and the
   * difference matters when somebody appeals something they say they never heard about.
   */
  async enforcement(id: string) {
    await this.policy.assertIsMember(id);

    const now = new Date();
    const [strikes, suspensions] = await Promise.all([
      this.database.strike.findMany({ where: { userId: id }, orderBy: { issuedAt: 'desc' } }),
      this.database.suspension.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' } }),
    ]);

    const staff = await this.staffRefs([
      ...strikes.flatMap(strike => [strike.issuedById, strike.revokedById]),
      ...suspensions.flatMap(suspension => [suspension.issuedById, suspension.liftedById]),
    ]);

    const strikeViews = strikes.map(strike => ({
      id: strike.id,
      reasonCode: strike.reasonCode,
      policySubtype: strike.policySubtype,
      note: strike.note,
      source: { type: strike.sourceType, id: strike.sourceId },
      issuedBy: staff.get(strike.issuedById) ?? null,
      issuedAt: strike.issuedAt.toISOString(),
      expiresAt: strike.expiresAt.toISOString(),
      active: !strike.revokedAt && strike.expiresAt > now,
      revokedAt: strike.revokedAt?.toISOString() ?? null,
      revokedBy: strike.revokedById ? (staff.get(strike.revokedById) ?? null) : null,
      notifiedAt: strike.notifiedAt?.toISOString() ?? null,
    }));

    return {
      strikes: strikeViews,
      suspensions: suspensions.map(suspension => ({
        id: suspension.id,
        startsAt: suspension.startsAt.toISOString(),
        endsAt: suspension.endsAt?.toISOString() ?? null,
        reasonCode: suspension.reasonCode,
        policySubtype: suspension.policySubtype,
        note: suspension.note,
        issuedBy: staff.get(suspension.issuedById) ?? null,
        liftedAt: suspension.liftedAt?.toISOString() ?? null,
        // Lifted with nobody named is the expiry job rather than a person, which is how a sentence
        // that ran out is told apart from one somebody chose to end.
        liftedBy: suspension.liftedById ? (staff.get(suspension.liftedById) ?? null) : null,
        liftedByJob: Boolean(suspension.liftedAt && !suspension.liftedById),
        active: !suspension.liftedAt && (suspension.endsAt === null || suspension.endsAt > now),
        createdAt: suspension.createdAt.toISOString(),
      })),
      warnings: strikeViews.filter(strike => strike.notifiedAt !== null),
      activeStrikes: strikeViews.filter(strike => strike.active).length,
    };
  }

  // ─── Linkable cases ────────────────────────────────────────────────────────

  /**
   * The records a thread-access grant may be tied to (§5.6, S9.1).
   *
   * A grant must name a case, and the case must exist, be visible to the caller under their own
   * permissions, and involve the member. Free text is never accepted — "investigating a complaint"
   * is not a reason anybody can check afterwards. This is the picker that list comes from, so it is
   * filtered by the caller's permissions here and not in the portal: an option a staff member can
   * see but not use is an invitation to ask somebody else to use it for them.
   *
   * Support threads have no table yet (§4.8); they join this list with their own section, and the
   * contract does not change when they do.
   */
  async linkableCases(actor: AdminPrincipal, id: string): Promise<LinkableCaseView[]> {
    await this.policy.assertIsMember(id);

    const cases: LinkableCaseView[] = [];
    const since = new Date(Date.now() - 90 * 86_400_000);

    // Gated like every other kind here, which it was not: a dispute is read behind
    // `disputes:manage` (§5.17), so offering one to somebody without it is offering a link they
    // cannot use — and §5.6 refuses it on exactly that permission, so the option was an invitation
    // to ask a colleague to take the grant instead.
    if (actor.permissions.has('disputes:manage')) {
      /**
       * Either party, not just the one who complained.
       *
       * §5.6 accepts a dispute as a reason to read the thread when the member is on *either* side
       * of it — raiser, the other party to the booking, or the other party to the enquiry. This
       * list only offered the ones they raised, so the commonest case (a professional whose work
       * is being disputed) had a valid reason that was never shown, and the only way through was
       * to ask a colleague to take the grant instead.
       */
      const disputes = await this.database.dispute.findMany({
        where: {
          createdAt: { gte: since },
          OR: [
            { raisedById: id },
            { booking: { OR: [{ clientId: id }, { professionalId: id }] } },
            { enquiry: { OR: [{ buyerId: id }, { sellerId: id }] } },
          ],
        },
        select: { id: true, reasonCode: true, state: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 25,
      });

      for (const dispute of disputes) {
        cases.push({
          type: 'DISPUTE',
          id: dispute.id,
          label: `Dispute — ${dispute.reasonCode} (${dispute.state})`,
          createdAt: dispute.createdAt.toISOString(),
        });
      }
    }

    // The support threads, which this list promised and did not have: §5.15 landed after it, and
    // "I am answering this member's support thread" is the commonest honest reason to read a
    // conversation they are complaining about. A `GUARD` thread is left out unless the caller
    // holds `guard:read` — R7, and the same rule §5.6 applies when the grant is asked for.
    if (actor.permissions.has('support:read')) {
      const threads = await this.database.supportThread.findMany({
        where: {
          memberId: id,
          createdAt: { gte: since },
          ...(this.policy.maySeeGuardThreads(actor)
            ? {}
            : { type: { not: SupportThreadType.GUARD } }),
        },
        select: { conversationId: true, type: true, state: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 25,
      });

      for (const thread of threads) {
        cases.push({
          // The **conversation** id, which is how §5.15 addresses a support thread and what §5.6
          // expects as the `linkedId`.
          type: 'SUPPORT_THREAD',
          id: thread.conversationId,
          label: `Support — ${thread.type} (${thread.state})`,
          createdAt: thread.createdAt.toISOString(),
        });
      }
    }

    if (actor.permissions.has('reports:read')) {
      // The reported member, not the reporter: a grant is read as "I am looking into what happened
      // to this person", and a case where they were the one complaining is somebody else's record.
      const reports = await this.database.reportCase.findMany({
        where: { targetUserId: id, createdAt: { gte: since } },
        select: { id: true, targetType: true, state: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 25,
      });

      for (const report of reports) {
        cases.push({
          type: 'REPORT_CASE',
          id: report.id,
          label: `Report — ${report.targetType} (${report.state})`,
          createdAt: report.createdAt.toISOString(),
        });
      }

      const escalations = await this.database.escalation.findMany({
        where: { memberId: id, createdAt: { gte: since } },
        select: { id: true, category: true, state: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 25,
      });

      for (const escalation of escalations) {
        cases.push({
          type: 'ESCALATION',
          id: escalation.id,
          label: `Escalation — ${escalation.category} (${escalation.state})`,
          createdAt: escalation.createdAt.toISOString(),
        });
      }
    }

    if (actor.permissions.has('guard:read')) {
      const guard = await this.database.guardThread.findMany({
        where: { userId: id, createdAt: { gte: since } },
        select: { id: true, subject: true, state: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 25,
      });

      for (const thread of guard) {
        cases.push({
          type: 'GUARD_CASE',
          id: thread.id,
          label: `Guard — ${thread.subject} (${thread.state})`,
          createdAt: thread.createdAt.toISOString(),
        });
      }
    }

    if (actor.permissions.has('moderation:read')) {
      const queue = await this.database.moderationQueueItem.findMany({
        where: { subjectUserId: id, createdAt: { gte: since } },
        select: { id: true, type: true, state: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 25,
      });

      for (const item of queue) {
        cases.push({
          type: 'QUEUE_ITEM',
          id: item.id,
          label: `Queue — ${item.type} (${item.state})`,
          createdAt: item.createdAt.toISOString(),
        });
      }
    }

    return cases.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // ─── Blocks ────────────────────────────────────────────────────────────────

  /**
   * Who has blocked them, and whom they have blocked.
   *
   * Behind `moderation:read` rather than `members:read`, because the shape of this is diagnostic:
   * one member blocked by fifteen people in a week is a pattern, and the fifteen names are the
   * people who did not want to be found by them.
   */
  async blocks(id: string): Promise<MemberBlocksView> {
    await this.policy.assertIsMember(id);

    const [blockedBy, blocking, recentIn, recentOut] = await Promise.all([
      this.database.block.count({ where: { blockedId: id } }),
      this.database.block.count({ where: { blockerId: id } }),
      this.database.block.findMany({
        where: { blockedId: id },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { createdAt: true, blocker: { select: memberRefSelect } },
      }),
      this.database.block.findMany({
        where: { blockerId: id },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { createdAt: true, blocked: { select: memberRefSelect } },
      }),
    ]);

    const recent = [
      ...recentIn.map(row => ({
        member: toMemberRef(row.blocker, this.sign),
        direction: 'BLOCKED_BY' as const,
        createdAt: row.createdAt.toISOString(),
      })),
      ...recentOut.map(row => ({
        member: toMemberRef(row.blocked, this.sign),
        direction: 'BLOCKING' as const,
        createdAt: row.createdAt.toISOString(),
      })),
    ]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 10);

    return { blockedBy, blocking, recent };
  }

  // ─── Audit ─────────────────────────────────────────────────────────────────

  /**
   * Everything staff have done to this member, within the caller's own audit scope (R8).
   *
   * Scope applied in the query. A reader with `audit:read_self` sees their own actions on this
   * member and nothing else — which is a short list, and an honest one. Returning the rows and
   * hiding them in the portal would mean a safeguarding entry had already crossed the wire.
   */
  async audit(
    actor: AdminPrincipal,
    id: string,
    dto: AdminPageOptionsDto,
  ): Promise<Paged<AuditEntryView>> {
    await this.policy.assertIsMember(id);
    dto.assertDepth();

    const scope = auditScopeFor(actor);

    if (!scope) {
      throw ApiException.forbidden(ApiErrorCode.FORBIDDEN, 'You cannot read the audit trail.');
    }

    const where: Prisma.AuditLogWhereInput = {
      AND: [{ targetType: 'MEMBER', targetId: id }, scope],
    };

    const [total, rows] = await Promise.all([
      this.database.auditLog.count({ where }),
      this.database.auditLog.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        skip: (dto.currentPage - 1) * dto.size,
        take: dto.size,
      }),
    ]);

    const staff = await this.staffRefs(rows.map(row => row.actorId));

    return {
      data: rows.map(row =>
        toAuditEntry(row, row.actorId ? (staff.get(row.actorId) ?? null) : null),
      ),
      meta: this.page(dto, total),
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────
  /**
   * Staff rows for a set of ids, in one query.
   *
   * Strikes, suspensions and audit entries hold `issuedById` as a plain column rather than a
   * relation — deliberately, so a staff account can be deleted without taking the record of what
   * they decided with it. The cost is this lookup, and a `null` where the account has since gone,
   * which is the honest answer rather than a blank name.
   */
  private async staffRefs(ids: Array<string | null>) {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];

    if (!unique.length) return new Map<string, ReturnType<typeof toStaffRef>>();

    const rows = await this.database.user.findMany({
      where: { id: { in: unique } },
      select: staffRefSelect,
    });

    return new Map(rows.map(row => [row.id, toStaffRef(row, this.sign)]));
  }

  private async ageBands(): Promise<AgeBand[]> {
    const terms = await this.taxonomy.list(TaxonomyKind.CONNECT_AGE_BAND, false);

    return terms
      .map(term => {
        const metadata = (term.metadata ?? {}) as { minAge?: number; maxAge?: number | null };

        return typeof metadata.minAge === 'number'
          ? { code: term.code, minAge: metadata.minAge, maxAge: metadata.maxAge ?? null }
          : null;
      })
      .filter((band): band is AgeBand => band !== null);
  }

  /** A JSON array column as the list of codes it holds, never null and never a string. */
  private codeList(value: Prisma.JsonValue | null | undefined): string[] {
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : [];
  }

  private page(
    dto: { currentPage: number; size: number },
    total: number,
    extra?: Record<string, unknown>,
  ) {
    return buildPageMeta({ currentPage: dto.currentPage, perPage: dto.size }, total, extra);
  }
}
