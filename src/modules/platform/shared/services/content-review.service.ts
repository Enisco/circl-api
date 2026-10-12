import { Injectable } from '@nestjs/common';
import {
  ContentRiskTier,
  ContentVisibilityState,
  ModerationQueueType,
  ReportTargetType,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { REVIEW_MESSAGE, ReviewStatus, isReachable, reviewStatusOf } from './content-visibility';

/** One crisis or advice line, in the shape the app's sheet already reads (§1.9.3). */
export interface SupportLineView {
  name: string;
  phone: string | null;
  /** The app's own name for the same field. Both are sent, as `GET guard/resources` does. */
  number: string | null;
  description: string | null;
  url: string | null;
  hours: string | null;
  isCrisis: boolean;
}

/**
 * What the **author** of held content is told (§6.5).
 *
 * Null for anything they have no reason to think about, which includes a limited post: it reads as
 * normal to the person who wrote it, because telling somebody their post has been quietly demoted
 * invites them to post it again, and the demotion is provisional until a human looks.
 */
export interface AuthorReviewView {
  reviewStatus: Exclude<ReviewStatus, null>;
  /** The sentence the app shows. Plain, and deliberately not an accusation. */
  reviewMessage: string;
  /** Why it was turned down, where somebody has written one. */
  reviewReason: string | null;
  /**
   * Only on the critical tier, and the reason it exists: at this point the most likely thing is
   * that the person who wrote the post needs help, not that they have broken a rule. §6.5 asks for
   * supportive copy and the crisis lines, never punitive copy.
   */
  support: { message: string; resources: SupportLineView[] } | null;
}

/**
 * The copy for a critical hold.
 *
 * Addressed to somebody who may be in trouble: it does not mention rules, moderation or review
 * outcomes, because the content that reaches this tier is usually a disclosure rather than an
 * offence.
 */
const SUPPORT_MESSAGE =
  'Your post is with our team. If you are in danger or need to talk to somebody now, these ' +
  'lines are free and open to anyone in the UK.';

@Injectable()
export class ContentReviewService {
  constructor(private readonly database: PrismaService) {}

  /**
   * The block to attach to an author's own copy of their content, or null.
   *
   * Reads the safety row only when there is something to say, so an ordinary post costs no extra
   * query: the visibility state on the content row is enough to know whether to ask.
   */
  async forAuthor(
    targetType: ReportTargetType,
    targetId: string,
    state: ContentVisibilityState,
  ): Promise<AuthorReviewView | null> {
    const reviewStatus = reviewStatusOf(state);

    if (!reviewStatus || isReachable(state)) return null;

    const safety = await this.database.contentSafety.findUnique({
      where: { targetType_targetId: { targetType, targetId } },
      select: { tier: true },
    });

    return {
      reviewStatus,
      reviewMessage: REVIEW_MESSAGE[reviewStatus],
      reviewReason:
        reviewStatus === 'NOT_APPROVED' ? await this.reasonFor(targetType, targetId) : null,
      support:
        safety?.tier === ContentRiskTier.CRITICAL
          ? { message: SUPPORT_MESSAGE, resources: await this.crisisLines() }
          : null,
    };
  }

  /**
   * What a reviewer wrote when they turned it down.
   *
   * From the queue item rather than the safety row: the note belongs to the decision, and the
   * decision is the queue's. Null until somebody has made one — which, until the decision path
   * ships, is always, and an empty field is a more honest answer than inventing a sentence.
   */
  private async reasonFor(targetType: ReportTargetType, targetId: string): Promise<string | null> {
    const item = await this.database.moderationQueueItem.findFirst({
      where: {
        targetType,
        targetId,
        type: { in: [ModerationQueueType.FLAGGED_CONTENT, ModerationQueueType.ANONYMOUS_POST] },
        decidedAt: { not: null },
      },
      orderBy: { decidedAt: 'desc' },
      select: { decisionNote: true },
    });

    return item?.decisionNote ?? null;
  }

  /** The crisis lines, crisis first, in the order §1.9.3 publishes them. */
  private async crisisLines(): Promise<SupportLineView[]> {
    const rows = await this.database.supportResource.findMany({
      where: { isActive: true, countryCode: 'GB' },
      orderBy: [{ isCrisis: 'desc' }, { sort: 'asc' }, { name: 'asc' }],
      take: 6,
    });

    return rows.map(row => ({
      name: row.name,
      phone: row.phone,
      number: row.phone,
      description: row.description,
      url: row.url,
      hours: row.hours,
      isCrisis: row.isCrisis,
    }));
  }
}
