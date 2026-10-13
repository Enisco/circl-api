import { Injectable } from '@nestjs/common';
import { ContentVisibilityState, ReportTargetType } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { CONTENT_SOURCE } from '@/modules/platform/shared';

/**
 * "What is this item about", for every screen that shows a list of targets.
 *
 * Three screens ask the same question — the moderation queue (§5.9), a report case (§5.10) and the
 * content page (§5.7) — and each had started answering it its own way. The queue's version was a
 * hand-written switch over **six** of the twenty-odd target types, so a flagged Connect post, a
 * flagged guide, a flagged shop and a flagged listing all appeared in the queue with no content on
 * the row at all: a reviewer looking at "something was flagged" and nothing else.
 *
 * `CONTENT_SOURCE` already knows every scannable kind's table, its scanned fields and its
 * visibility column, because §6 needs that to scan them. So this reads from there, which means a
 * kind added to the scanner appears here without anybody remembering to come back.
 *
 * One raw query per target type, not per row: a queue page of 100 items across six kinds is six
 * queries rather than a hundred.
 */

export interface ContentTargetView {
  targetType: ReportTargetType;
  targetId: string;
  /** A line a reviewer can recognise the thing by, taken from the content itself. */
  title: string | null;
  /** Whether it has already been taken down. */
  removed: boolean;
  /** For a MESSAGE or CONVERSATION target, the thread §5.6 would open. */
  conversationId: string | null;
  /**
   * The content's own visibility, which is what decides whether a reviewer is offered `APPROVE`
   * or `RESTORE_REACH` (§5.9's table). Null for a target with no such column — a member, a
   * conversation — or for content that has since been hard-deleted.
   */
  visibilityState: ContentVisibilityState | null;
  /** Every scanned field, by name, for the detail page's highlight offsets (§5.9). */
  fields: Record<string, string | null>;
  /**
   * The rest of §5.0's `ContentRef`, which the queue and the report case both publish.
   *
   * Read off the row the resolver already has — it selects `*` — rather than fetched again: a
   * queue page was showing `{ targetType, targetId, title }` and nothing else, so the portal's
   * content card had no excerpt, no author, no date and no link to open.
   */
  excerpt: string | null;
  authorId: string | null;
  /** `PUBLIC`, `ANONYMOUS`, `PRIVATE_TO_CIRCL` — where the kind has the concept. */
  visibility: string | null;
  deletedAt: string | null;
  createdAt: string | null;
}

@Injectable()
export class AdminContentTargetService {
  constructor(private readonly database: PrismaService) {}

  /** `${targetType}:${targetId}` → the view. Targets with no content row are simply absent. */
  async resolve(
    rows: Array<{ targetType: ReportTargetType; targetId: string }>,
  ): Promise<Map<string, ContentTargetView>> {
    const byType = new Map<ReportTargetType, string[]>();

    for (const row of rows) {
      byType.set(row.targetType, [...(byType.get(row.targetType) ?? []), row.targetId]);
    }

    const result = new Map<string, ContentTargetView>();

    await Promise.all(
      [...byType.entries()].map(async ([targetType, ids]) => {
        const source = CONTENT_SOURCE[targetType];

        if (!source) return;

        // `ANY($1::text[])` rather than an interpolated `IN` list: the ids come from our own rows,
        // but a parameterised array is the habit worth keeping in a raw query.
        const content = await this.database.$queryRawUnsafe<Array<Record<string, unknown>>>(
          `SELECT * FROM "${source.table}" WHERE "id" = ANY($1::text[])`,
          [...new Set(ids)],
        );
        const column = source.column ?? 'visibility_state';

        for (const item of content) {
          const fields = source.toFields(item);
          const first = Object.values(fields).find(value => !!value?.trim());
          const visibility = item[column];

          // The longest scanned field, trimmed: a title is the first non-empty one and an excerpt
          // should be the body where there is one. 280 characters, as §5.0 specifies — enough to
          // recognise a post by and not enough to read one in a list.
          const longest = Object.values(fields)
            .filter((value): value is string => !!value?.trim())
            .sort((a, b) => b.length - a.length)[0];

          result.set(`${targetType}:${item.id as string}`, {
            targetType,
            targetId: item.id as string,
            title: first ? first.slice(0, 200) : null,
            removed: (item.deleted_at ?? null) !== null || item.is_active === false,
            conversationId: (item.conversation_id as string | null) ?? null,
            visibilityState:
              typeof visibility === 'string' ? (visibility as ContentVisibilityState) : null,
            fields,
            excerpt: longest ? longest.slice(0, 280) : null,
            // `author_id` on most, `user_id` on the ones that belong to a member rather than being
            // written by one — a listing, a store, a Connect profile.
            authorId: (item.author_id as string | null) ?? (item.user_id as string | null) ?? null,
            visibility: typeof item.visibility === 'string' ? item.visibility : null,
            deletedAt: toIso(item.deleted_at),
            createdAt: toIso(item.created_at ?? item.posted_at),
          });
        }
      }),
    );

    return result;
  }

  /** The key both callers build, so neither can build it differently. */
  key(row: { targetType: ReportTargetType; targetId: string }): string {
    return `${row.targetType}:${row.targetId}`;
  }
}

/** A raw column, which comes back as a `Date` from pg and as a string from nothing else. */
const toIso = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString();

  return typeof value === 'string' ? value : null;
};
