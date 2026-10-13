import { ReportTargetType } from '@prisma/client';
import { CONTENT_SOURCE } from '@/modules/platform/shared';

/**
 * What §5.7 needs to know about each kind of content, beyond what the scanner already knows.
 *
 * `CONTENT_SOURCE` carries the table, the scanned fields, the media owners and the visibility
 * column, because §6 needs those to scan anything — and this reads from it rather than repeating
 * it, so a kind added to the scanner cannot be half-added here. What it does **not** know is
 * everything a staff list is made of: who wrote it, which city it belongs to, what its category
 * is, what "status" means for this kind, which numbers to show and what can be filtered.
 *
 * One table per kind, written out, because every one of them is different in a way that cannot be
 * derived. `professional_services` has no author of its own and no `deleted_at`; Connect posts and
 * stories are dated by `posted_at`; a group's author is `created_by_id`, a store's is `owner_id`, a
 * review's is `reviewer_id`. A clever generic version of this would be a list of exceptions with a
 * loop around it.
 */

/** A column on the content's own table, or null where the kind has no such thing. */
type Column = string | null;

export interface ContentKind {
  /** The URL segment, which is what the portal routes on. */
  slug: string;
  targetType: ReportTargetType;
  /** Plural, for messages: "3 requests". */
  label: string;
  /** Who wrote it. Null when the row has no author column — see `authorVia`. */
  author: Column;
  /**
   * For a kind whose author lives on a parent row: the join that reaches it.
   *
   * A Connect post belongs to a profile and a professional service belongs to a listing, and
   * neither carries the member's id. Written as a join rather than resolved in a second pass so
   * that `authorId` can be *filtered* on, which a second pass cannot do.
   */
  authorVia?: { table: string; on: string; column: string };
  city: Column;
  /** The taxonomy code column, for the per-type category filter. */
  category: Column;
  /** Which taxonomy the category belongs to, for labelling. */
  categoryKind?: string;
  /** What `createdAt` means for this kind. */
  created: string;
  /** Null for a kind that cannot be soft-deleted, which changes what `deleted` can mean. */
  deleted: Column;
  /**
   * The expression behind `row.status`, as SQL. Type-specific by nature: a request has a status, a
   * guide is published or a draft, a store has a compliance state, a story is active or expired.
   */
  status?: string;
  /** `{ name: column }`, projected into `row.metrics`. */
  metrics: Record<string, string>;
  /** Sortable columns beyond the three every kind has. */
  sorts?: Record<string, string>;
  /** Whether a title exists to search; otherwise `q` searches the body only. */
  searchable: string[];
}

const KINDS: ContentKind[] = [
  {
    slug: 'requests',
    targetType: ReportTargetType.REQUEST,
    label: 'Requests',
    author: 'author_id',
    city: 'city_id',
    category: 'category_code',
    categoryKind: 'COMMUNITY_CATEGORY',
    created: 'created_at',
    deleted: 'deleted_at',
    status: 'c."status"::text',
    metrics: { views: 'view_count', replies: 'reply_count', helpers: 'helper_count' },
    sorts: { viewCount: 'view_count' },
    searchable: ['title', 'description'],
  },
  {
    slug: 'responses',
    targetType: ReportTargetType.RESPONSE,
    label: 'Replies',
    author: 'author_id',
    city: null,
    category: null,
    created: 'created_at',
    deleted: 'deleted_at',
    metrics: {},
    searchable: ['content'],
  },
  {
    slug: 'offers',
    targetType: ReportTargetType.OFFER,
    label: 'Offers',
    author: 'author_id',
    city: 'city_id',
    category: 'category_code',
    categoryKind: 'COMMUNITY_CATEGORY',
    created: 'created_at',
    deleted: 'deleted_at',
    metrics: { views: 'view_count' },
    sorts: { viewCount: 'view_count' },
    searchable: ['title', 'description'],
  },
  {
    slug: 'updates',
    targetType: ReportTargetType.UPDATE,
    label: 'Posts',
    author: 'author_id',
    city: 'city_id',
    category: null,
    created: 'created_at',
    deleted: 'deleted_at',
    metrics: { views: 'view_count', replies: 'reply_count', reactions: 'reaction_count' },
    sorts: { viewCount: 'view_count' },
    searchable: ['content'],
  },
  {
    slug: 'update-replies',
    targetType: ReportTargetType.UPDATE_REPLY,
    label: 'Post replies',
    author: 'author_id',
    city: null,
    category: null,
    created: 'created_at',
    deleted: 'deleted_at',
    metrics: {},
    searchable: ['content'],
  },
  {
    slug: 'guides',
    targetType: ReportTargetType.GUIDE,
    label: 'Guides',
    author: 'author_id',
    city: 'city_id',
    category: 'topic_code',
    categoryKind: 'GUIDE_TOPIC',
    created: 'created_at',
    deleted: 'deleted_at',
    // Published or still a draft, which is the distinction the guides screen is built on.
    status: `CASE WHEN c."published_at" IS NULL THEN 'DRAFT' ELSE 'PUBLISHED' END`,
    metrics: { views: 'view_count', likes: 'like_count', readMinutes: 'read_time_minutes' },
    sorts: { viewCount: 'view_count' },
    searchable: ['title', 'intro'],
  },
  {
    slug: 'groups',
    targetType: ReportTargetType.GROUP,
    label: 'Groups',
    author: 'created_by_id',
    city: 'city_id',
    category: 'category_code',
    categoryKind: 'COMMUNITY_CATEGORY',
    created: 'created_at',
    deleted: 'deleted_at',
    status: 'c."join_policy"::text',
    metrics: { members: 'member_count', posts: 'post_count' },
    sorts: { memberCount: 'member_count' },
    searchable: ['name', 'description'],
  },
  {
    slug: 'group-posts',
    targetType: ReportTargetType.GROUP_POST,
    label: 'Group posts',
    author: 'author_id',
    city: null,
    category: null,
    created: 'created_at',
    deleted: 'deleted_at',
    metrics: { replies: 'reply_count' },
    searchable: ['content'],
  },
  {
    slug: 'group-post-replies',
    targetType: ReportTargetType.GROUP_POST_REPLY,
    label: 'Group post replies',
    author: 'author_id',
    city: null,
    category: null,
    created: 'created_at',
    deleted: 'deleted_at',
    metrics: {},
    searchable: ['content'],
  },
  {
    slug: 'connect-profiles',
    targetType: ReportTargetType.CONNECT_PROFILE,
    label: 'Connect profiles',
    author: 'user_id',
    // The override only: a Connect profile's city is the member's unless they moved it.
    city: 'city_id_override',
    category: 'type_code',
    categoryKind: 'CONNECTION_TYPE',
    created: 'created_at',
    deleted: 'deleted_at',
    status: `CASE WHEN c."is_visible" THEN 'VISIBLE' ELSE 'HIDDEN' END`,
    metrics: {},
    searchable: ['looking_for'],
  },
  {
    slug: 'connect-posts',
    targetType: ReportTargetType.CONNECT_POST,
    label: 'Connect posts',
    author: null,
    authorVia: { table: 'connect_profiles', on: 'profile_id', column: 'user_id' },
    city: null,
    category: null,
    created: 'posted_at',
    deleted: 'deleted_at',
    status: 'c."kind"::text',
    metrics: {},
    searchable: ['caption'],
  },
  {
    slug: 'connect-stories',
    targetType: ReportTargetType.CONNECT_STORY,
    label: 'Connect stories',
    author: 'user_id',
    city: null,
    category: null,
    created: 'posted_at',
    deleted: 'deleted_at',
    // A story is content with a deadline, and "has it expired" is the first thing staff ask.
    status: `CASE WHEN c."expires_at" > NOW() THEN 'ACTIVE' ELSE 'EXPIRED' END`,
    metrics: {},
    searchable: ['caption'],
  },
  {
    slug: 'listings',
    targetType: ReportTargetType.PROFESSIONAL_LISTING,
    label: 'Professional listings',
    author: 'user_id',
    city: 'city_id',
    category: null,
    created: 'created_at',
    deleted: 'deleted_at',
    status: 'c."verification_status"::text',
    metrics: { views: 'profile_views', jobs: 'jobs_completed' },
    sorts: { viewCount: 'profile_views' },
    searchable: ['profession_title', 'about'],
  },
  {
    slug: 'services',
    targetType: ReportTargetType.PROFESSIONAL_SERVICE,
    label: 'Services',
    author: null,
    authorVia: { table: 'professional_listings', on: 'listing_id', column: 'user_id' },
    city: null,
    category: null,
    created: 'created_at',
    // No `deleted_at` on this table: a service is removed outright, so there is nothing to
    // restore and `deleted` cannot be filtered on. The list says so rather than pretending.
    deleted: null,
    status: `CASE WHEN c."is_active" THEN 'ACTIVE' ELSE 'INACTIVE' END`,
    metrics: {},
    searchable: ['name', 'description'],
  },
  {
    slug: 'stores',
    targetType: ReportTargetType.STORE,
    label: 'Shops',
    author: 'owner_id',
    city: 'city_id',
    category: 'type_code',
    categoryKind: 'STORE_TYPE',
    created: 'created_at',
    deleted: 'deleted_at',
    status: 'c."compliance_state"::text',
    metrics: { views: 'view_count', enquiries: 'enquiry_count' },
    sorts: { viewCount: 'view_count' },
    searchable: ['name', 'description'],
  },
  {
    slug: 'items',
    targetType: ReportTargetType.STORE_ITEM,
    label: 'Items',
    author: null,
    authorVia: { table: 'stores', on: 'store_id', column: 'owner_id' },
    city: null,
    category: 'category_code',
    categoryKind: 'ITEM_CATEGORY',
    created: 'created_at',
    deleted: 'deleted_at',
    status: 'c."availability"::text',
    metrics: { views: 'view_count' },
    sorts: { viewCount: 'view_count' },
    searchable: ['name', 'description'],
  },
  {
    slug: 'reviews',
    targetType: ReportTargetType.REVIEW,
    label: 'Reviews',
    author: 'reviewer_id',
    city: null,
    category: null,
    created: 'created_at',
    deleted: 'deleted_at',
    status: 'c."context"::text',
    metrics: { rating: 'rating' },
    sorts: { rating: 'rating' },
    searchable: ['comment'],
  },
];

export const CONTENT_KINDS: Record<string, ContentKind> = Object.fromEntries(
  KINDS.map(kind => [kind.slug, kind]),
);

export const CONTENT_SLUGS = KINDS.map(kind => kind.slug);

/**
 * The table a kind lives in, read from the scanner's own registry.
 *
 * Deliberately not duplicated in `ContentKind`: two declarations of which table holds requests is
 * one that will disagree, and the scanner's is the one that has to be right.
 */
export const tableFor = (kind: ContentKind): string => {
  const source = CONTENT_SOURCE[kind.targetType];

  if (!source) {
    // Not reachable: every slug above names a scannable type. Thrown rather than defaulted,
    // because a silent fallback here would build a query against the wrong table.
    throw new Error(`No content source for ${kind.targetType}`);
  }

  return source.table;
};

/** The visibility column, which a couple of kinds name differently. */
export const visibilityColumnFor = (kind: ContentKind): string =>
  CONTENT_SOURCE[kind.targetType]?.column ?? 'visibility_state';

/**
 * The kind that owns a target type, for callers holding a `ReportTargetType` rather than a slug.
 *
 * The queue and a report case both address content by target type — that is what a report carries
 * — and the content page is addressed by slug, because that is what the portal routes on. One map
 * built from the same list, rather than each caller writing its own switch: the queue's old
 * hand-written one covered six of the seventeen kinds.
 *
 * A type with no kind returns null, and several have none on purpose: `USER`, `CONVERSATION` and
 * `MESSAGE` are not content pages, and `CONNECT_MEDIA` is one photo out of a post — its id is a
 * media id, so resolving it to the Connect posts kind would query the posts table with the wrong
 * id and 404 a case that is perfectly fine.
 */
const BY_TARGET: Partial<Record<ReportTargetType, ContentKind>> = Object.fromEntries(
  KINDS.map(kind => [kind.targetType, kind]),
);

export const kindForTarget = (targetType: ReportTargetType): ContentKind | null =>
  BY_TARGET[targetType] ?? null;
