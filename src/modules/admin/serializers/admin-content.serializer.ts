import { ContentVisibilityState, MediaType, ReportTargetType } from '@prisma/client';
import { ContentTargetView } from '../services/admin-content-target.service';
import { MemberRefView } from './admin-member.serializer';
import { RiskView } from './admin-risk.serializer';
import { contentAdminUrl } from './admin-url';

/**
 * §5.0's `ContentRef`, and the two shapes built on it (§5.7's `AdminContentRow` and
 * `AdminContentPage`).
 *
 * Four screens show the same piece of content — the moderation queue (§5.9), a report case's live
 * content (§5.10), the content tab (§5.7) and a member's content tab (§5.5) — and each had grown
 * its own answer to "what is this". The queue's row carried six fields, the content list called
 * the id `id` and gave the city as `{ id }`, and a report case carried `liveContent: null`
 * whatever the target was. So the portal's one content card had to be written three times, and
 * two of them could not link anywhere because neither carried `adminUrl`.
 *
 * One builder, used by all of them. A card that renders in the queue renders on a case.
 */
export interface ContentRefView {
  targetType: ReportTargetType;
  targetId: string;
  title: string | null;
  /** ≤ 280 characters, per §5.0: enough to recognise a post by, not enough to read one in a list. */
  excerpt: string | null;
  author: MemberRefView | null;
  /** `PUBLIC`, `ANONYMOUS`, `PRIVATE_TO_CIRCL` — where the kind has the concept. */
  visibility: string | null;
  visibilityState: ContentVisibilityState | null;
  deletedAt: string | null;
  createdAt: string | null;
  /** A portal-relative path. Null for a kind with no page of its own — see `admin-url.ts`. */
  adminUrl: string | null;
  /**
   * Kept beside `deletedAt`, which is the spec's field: `removed` is what §6.6's decision table
   * reads to decide whether `RESTORE` is offered, and it is true for a kind whose removal is a
   * flag (`is_active`) rather than a timestamp.
   */
  removed: boolean;
  /** For a MESSAGE or CONVERSATION target, the thread §5.6 would open. */
  conversationId: string | null;
}

/**
 * What the caller knows without the content row: the ids, and — for the content list, which
 * selects each kind's own `created`/`deleted` columns — the dates as that kind spells them.
 */
export interface ContentRefFallback {
  targetType: ReportTargetType;
  targetId: string;
  createdAt?: string | null;
  deletedAt?: string | null;
  visibilityState?: ContentVisibilityState | null;
}

/**
 * The ref, from the resolved content row where there is one.
 *
 * A null `target` is not an error: a report about a member, about a conversation, or about content
 * that has since been hard-deleted has no row to read. The ids and the link are still returned,
 * because a reviewer must always be able to open the thing they are deciding about, and `removed`
 * is true because there is nothing left to see.
 */
export const toContentRef = (
  fallback: ContentRefFallback,
  target: ContentTargetView | null,
  author: MemberRefView | null = null,
): ContentRefView => ({
  targetType: fallback.targetType,
  targetId: fallback.targetId,
  title: target?.title ?? null,
  excerpt: target?.excerpt ?? null,
  author,
  visibility: target?.visibility ?? null,
  visibilityState: target?.visibilityState ?? fallback.visibilityState ?? null,
  deletedAt: target?.deletedAt ?? fallback.deletedAt ?? null,
  createdAt: target?.createdAt ?? fallback.createdAt ?? null,
  adminUrl: contentAdminUrl(fallback.targetType, fallback.targetId),
  removed: target ? target.removed : true,
  conversationId: target?.conversationId ?? null,
});

export interface CodeView {
  code: string;
  label: string;
}

export interface CityRefView {
  id: string;
  name: string;
  region: string | null;
}

/** §5.7's list row. */
export interface AdminContentRowView extends ContentRefView {
  city: CityRefView | null;
  category: CodeView | null;
  /** Type-specific: a request's status, a guide's `DRAFT`/`PUBLISHED`, a store's compliance state. */
  status: string | null;
  metrics: Record<string, number>;
  reportCount: number;
  openCaseId: string | null;
  /** The three fields a list needs; the detail page carries the whole view. */
  risk: Pick<RiskView, 'tier' | 'finalScore' | 'category'> | null;
}

/** §5.7's detail page, which §5.9's `contentDetail` and §5.10's `liveContent` are also. */
export interface AdminContentPageView extends Omit<AdminContentRowView, 'author' | 'risk'> {
  /** Every scanned field by name; `text` is the one the risk signals' offsets refer to. */
  body: { text: string } & Record<string, unknown>;
  media: Array<{
    mediaId: string;
    type: MediaType;
    url: string | null;
    thumbnailUrl: string | null;
    moderationState: string;
  }>;
  risk: RiskView | null;
  author: (MemberRefView & { activeStrikes: number; accountAgeDays: number }) | null;
  /** An author's own deletion cannot be restored (`RESTORE_NOT_ALLOWED`). */
  deletedBy: 'STAFF' | 'AUTHOR' | null;
  openQueueItemId: string | null;
}
