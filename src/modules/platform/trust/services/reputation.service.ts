import { Injectable } from '@nestjs/common';
import { Prisma, ReviewContext } from '@prisma/client';
import { PrismaService } from '@/infrastructure';

/** The United Kingdom's code in the countriesOfOrigin taxonomy. */
const UK_CODE = 'GB';

/**
 * D11: a professional qualifies as immigrant-friendly at 3 or more reviews from
 * members whose country of origin is set and is not the UK, averaging 4 stars or
 * above.
 *
 * The rule is here, and its user-facing sentence ships through GET /taxonomy as
 * `immigrantFriendlyRule` so the wording a member reads and the query that
 * produced the result cannot drift apart. Change one, change the other.
 */
const IMMIGRANT_FRIENDLY_MIN_REVIEWS = 3;
const IMMIGRANT_FRIENDLY_MIN_AVERAGE = 4;

/**
 * Circl Trust: one reputation per user, visible everywhere.
 *
 * The summary is maintained rather than derived, for two reasons. A profile card
 * must not sum a page of reviews — the client only ever has one page, so it would
 * be summing the wrong thing (2.1.4). And Browse sorts and filters on rating
 * across thousands of listings, which is an index scan against this table or an
 * aggregate per row against the other one.
 */
@Injectable()
export class ReputationService {
  constructor(private readonly database: PrismaService) {}

  /**
   * Recomputes a member's summary from their reviews. Called after every write
   * that could change it, inside the same transaction.
   */
  async recompute(userId: string, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.database;

    const reviews = await client.review.findMany({
      where: { subjectUserId: userId, deletedAt: null },
      select: {
        rating: true,
        context: true,
        countsToAverage: true,
        reviewerCountryOfOrigin: true,
      },
    });

    const counted = reviews.filter(review => review.countsToAverage);
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<number, number>;

    for (const review of counted) {
      distribution[review.rating] = (distribution[review.rating] ?? 0) + 1;
    }

    const average = counted.length
      ? counted.reduce((total, review) => total + review.rating, 0) / counted.length
      : 0;

    // D11's one known consequence, worth restating where it bites: countryOfOrigin
    // is optional at onboarding, so a reviewer who skipped it does not count, and
    // neither does a second-generation member born here. The filter therefore
    // under-counts rather than over-counts, which is the safer direction for a
    // badge but means the real number is larger than this one.
    const immigrantReviews = counted.filter(
      review => review.reviewerCountryOfOrigin && review.reviewerCountryOfOrigin !== UK_CODE,
    );
    const immigrantAverage = immigrantReviews.length
      ? immigrantReviews.reduce((total, review) => total + review.rating, 0) /
        immigrantReviews.length
      : 0;

    const byContext = (context: ReviewContext) =>
      reviews.filter(review => review.context === context).length;

    const data = {
      average: Number(average.toFixed(2)),
      countedTotal: counted.length,
      excludedTotal: reviews.length - counted.length,
      star5: distribution[5],
      star4: distribution[4],
      star3: distribution[3],
      star2: distribution[2],
      star1: distribution[1],
      communityCount: byContext(ReviewContext.COMMUNITY),
      bookingCount: byContext(ReviewContext.BOOKING),
      orderCount: byContext(ReviewContext.ORDER),
      priorWorkCount: byContext(ReviewContext.PRIOR_WORK),
      immigrantReviewCount: immigrantReviews.length,
      immigrantReviewAverage: Number(immigrantAverage.toFixed(2)),
      isImmigrantFriendly:
        immigrantReviews.length >= IMMIGRANT_FRIENDLY_MIN_REVIEWS &&
        immigrantAverage >= IMMIGRANT_FRIENDLY_MIN_AVERAGE,
    };

    await client.reputationSummary.upsert({
      where: { userId },
      update: data,
      create: { userId, ...data },
    });
  }

  /** The rollup, or a zeroed one for a member nobody has reviewed yet. */
  async summaryFor(userId: string) {
    const summary = await this.database.reputationSummary.findUnique({ where: { userId } });

    return summary ?? this.empty(userId);
  }

  /** Summaries for a page of listings, in one query. */
  async summariesFor(userIds: string[]) {
    if (!userIds.length) return new Map<string, Awaited<ReturnType<typeof this.summaryFor>>>();

    const rows = await this.database.reputationSummary.findMany({
      where: { userId: { in: userIds } },
    });
    const map = new Map(rows.map(row => [row.userId, row] as const));

    for (const userId of userIds) {
      if (!map.has(userId)) map.set(userId, this.empty(userId) as (typeof rows)[number]);
    }

    return map;
  }

  /** The shape a profile renders, including the distribution bar chart (2.4). */
  toRatingView(summary: {
    average: number;
    countedTotal: number;
    excludedTotal: number;
    star1: number;
    star2: number;
    star3: number;
    star4: number;
    star5: number;
  }) {
    return {
      average: summary.average,
      count: summary.countedTotal,
      // The number of prior-work entries not counted, so a profile can print the
      // honest note about them without a second call (2.3).
      excludedCount: summary.excludedTotal,
      distribution: {
        5: summary.star5,
        4: summary.star4,
        3: summary.star3,
        2: summary.star2,
        1: summary.star1,
      },
    };
  }

  private empty(userId: string) {
    return {
      userId,
      average: 0,
      countedTotal: 0,
      excludedTotal: 0,
      star5: 0,
      star4: 0,
      star3: 0,
      star2: 0,
      star1: 0,
      communityCount: 0,
      bookingCount: 0,
      orderCount: 0,
      priorWorkCount: 0,
      immigrantReviewCount: 0,
      immigrantReviewAverage: 0,
      isImmigrantFriendly: false,
      updatedAt: new Date(),
    };
  }
}
