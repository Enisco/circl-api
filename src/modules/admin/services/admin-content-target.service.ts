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

          result.set(`${targetType}:${item.id as string}`, {
            targetType,
            targetId: item.id as string,
            title: first ? first.slice(0, 200) : null,
            removed: (item.deleted_at ?? null) !== null || item.is_active === false,
            conversationId: (item.conversation_id as string | null) ?? null,
            visibilityState:
              typeof visibility === 'string' ? (visibility as ContentVisibilityState) : null,
            fields,
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
