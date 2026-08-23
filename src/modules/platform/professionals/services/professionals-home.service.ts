import { Injectable } from '@nestjs/common';
import { JobState, ListingVerificationStatus, TaxonomyKind } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { daysAgo, money } from '@/common';
import { TaxonomyService, authorSelect, toAuthorView, toCityView, toTermView } from '../../shared';
import { ReputationService } from '../../trust/services/reputation.service';

/**
 * `GET /professionals/home` (2.2) and `GET /professionals/me/dashboard` (2.11).
 *
 * Home is one call for the whole screen, because it is six small strips and six
 * round trips would show six spinners.
 */
@Injectable()
export class ProfessionalsHomeService {
  constructor(
    private readonly database: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly reputation: ReputationService,
  ) {}

  async home(userId: string, cityId?: string) {
    const profile = await this.database.userProfile.findUnique({
      where: { userId },
      select: { cityId: true },
    });
    const city = cityId ?? profile?.cityId ?? null;

    const [professionLabels, categoryCounts, nearYou, myListing, activeBookings, trust] =
      await Promise.all([
        this.taxonomy.labels(TaxonomyKind.PROFESSION),
        this.database.professionalListingCategory.groupBy({
          by: ['code'],
          where: {
            listing: {
              deletedAt: null,
              verificationStatus: { not: ListingVerificationStatus.DRAFT },
              ...(city ? { cityId: city } : {}),
            },
          },
          _count: { _all: true },
        }),
        this.database.professionalListing.findMany({
          where: {
            deletedAt: null,
            isAcceptingWork: true,
            userId: { not: userId },
            verificationStatus: { not: ListingVerificationStatus.DRAFT },
            ...(city ? { cityId: city } : {}),
          },
          include: {
            user: { select: authorSelect },
            city: { select: { id: true, name: true, region: true } },
            categories: true,
          },
          take: 10,
        }),
        this.database.professionalListing.findUnique({
          where: { userId },
          include: { categories: true, services: { where: { isActive: true } } },
        }),
        this.database.booking.findMany({
          where: {
            OR: [{ clientId: userId }, { professionalId: userId }],
            state: {
              in: [
                JobState.PENDING_ACCEPTANCE,
                JobState.ACCEPTED,
                JobState.IN_PROGRESS,
                JobState.DELIVERED,
                JobState.CHANGES_REQUESTED,
              ],
            },
          },
          include: {
            client: { select: authorSelect },
            professional: { select: authorSelect },
          },
          orderBy: { updatedAt: 'desc' },
          // At most 3: an in-flight job should never require hunting through a
          // menu to find (2.2).
          take: 3,
        }),
        this.trustCounts(),
      ]);

    const summaries = await this.reputation.summariesFor(nearYou.map(row => row.userId));

    return {
      // Real counts, so an empty category can be handled honestly rather than
      // rendering a tile that leads nowhere.
      categories: categoryCounts
        .map(row => ({
          ...toTermView(row.code, professionLabels)!,
          professionalCount: row._count._all,
        }))
        .sort((a, b) => b.professionalCount - a.professionalCount),
      nearYou: nearYou.map(row => {
        const summary = summaries.get(row.userId)!;

        return {
          type: 'PROFESSIONAL' as const,
          id: row.id,
          user: toAuthorView(row.user),
          professionTitle: row.professionTitle,
          category: toTermView(row.categories[0]?.code ?? null, professionLabels),
          city: toCityView(row.city),
          rating: {
            average: summary.average,
            count: summary.countedTotal,
            excludedCount: summary.excludedTotal,
          },
          priceFrom: money(row.priceFrom, row.currency),
          priceBasis: row.priceBasis,
          isAcceptingWork: row.isAcceptingWork,
          isImmigrantFriendly: summary.isImmigrantFriendly,
        };
      }),
      // Null when the member has no listing. Its presence is what swaps the two
      // mode cards for the listing card, which the client currently decides from
      // a local flag (2.2).
      myListing: myListing
        ? {
            id: myListing.id,
            title: myListing.professionTitle,
            category: toTermView(myListing.categories[0]?.code ?? null, professionLabels),
            serviceCount: myListing.services.length,
            isAcceptingWork: myListing.isAcceptingWork,
            verificationStatus: myListing.verificationStatus,
          }
        : null,
      activeBookings: activeBookings.map(booking => ({
        id: booking.id,
        serviceName: booking.serviceName,
        counterpart: toAuthorView(
          booking.clientId === userId ? booking.professional : booking.client,
        ),
        state: booking.state,
      })),
      trust,
    };
  }

  /**
   * The trust strip. D13 makes `verifiedCount` honest rather than aspirational:
   * with no checks written, it counts the one check that exists.
   */
  private async trustCounts() {
    const [verifiedCount, ratedCount, vouchedCount] = await Promise.all([
      this.database.trustCheck.count({ where: { status: 'VERIFIED', check: { not: 'EMAIL' } } }),
      this.database.reputationSummary.count({ where: { countedTotal: { gt: 0 } } }),
      this.database.review.count({ where: { deletedAt: null } }),
    ]);

    return { verifiedCount, vouchedCount, ratedCount };
  }

  // ─── 2.11 Dashboard ────────────────────────────────────────────────────────

  /**
   * `agreedTotal` is the sum of amounts the two parties agreed, not money Circl
   * holds, owes, or has paid. The screen labels it "Earned so far" from the
   * professional's point of view, which is accurate about their work and says
   * nothing about Circl's involvement. There is no pending balance, no payout and
   * no Stripe status (2.11).
   */
  async dashboard(userId: string) {
    const listing = await this.database.professionalListing.findUnique({ where: { userId } });

    if (!listing) return null;

    const monthStart = new Date();

    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const [inProgress, completed, jobsThisMonth, bookingCount] = await Promise.all([
      this.database.booking.aggregate({
        where: {
          professionalId: userId,
          state: { in: [JobState.ACCEPTED, JobState.IN_PROGRESS, JobState.DELIVERED, JobState.CHANGES_REQUESTED] },
        },
        _count: { _all: true },
        _sum: { agreedAmount: true },
      }),
      this.database.booking.aggregate({
        where: { professionalId: userId, state: JobState.COMPLETED },
        _count: { _all: true },
        _sum: { agreedAmount: true },
      }),
      this.database.booking.count({
        where: {
          professionalId: userId,
          state: JobState.COMPLETED,
          completedAt: { gte: monthStart },
        },
      }),
      this.database.booking.count({ where: { professionalId: userId } }),
    ]);

    return {
      inProgress: {
        count: inProgress._count._all,
        agreedTotal: money(inProgress._sum.agreedAmount ?? 0, listing.currency),
      },
      completed: {
        count: completed._count._all,
        agreedTotal: money(completed._sum.agreedAmount ?? 0, listing.currency),
      },
      jobsThisMonth,
      medianResponseMinutes: listing.medianResponseMinutes,
      profileViews: listing.profileViews,
      conversion: {
        views: listing.profileViews,
        bookings: bookingCount,
        rate: listing.profileViews
          ? Number((bookingCount / listing.profileViews).toFixed(4))
          : 0,
      },
      isAcceptingWork: listing.isAcceptingWork,
    };
  }

  /**
   * Median minutes from the first client message to the professional's first
   * reply, over the last 30 days (2.11).
   *
   * One definition, three surfaces: the profile, the dashboard, and the
   * `maxResponseHours` filter all read the column this writes. Recomputed on a
   * schedule rather than per read, because it is a scan over messages.
   */
  async recomputeResponseTimes(): Promise<number> {
    const listings = await this.database.professionalListing.findMany({
      where: { deletedAt: null },
      select: { id: true, userId: true },
    });

    let updated = 0;

    for (const listing of listings) {
      const conversations = await this.database.conversation.findMany({
        where: {
          participants: { some: { userId: listing.userId } },
          lastMessageAt: { gte: daysAgo(30) },
        },
        select: {
          id: true,
          messages: {
            where: { senderId: { not: null }, deletedAt: null },
            orderBy: { sentAt: 'asc' },
            select: { senderId: true, sentAt: true },
            take: 40,
          },
        },
        take: 100,
      });

      const gaps: number[] = [];

      for (const conversation of conversations) {
        const firstFromOther = conversation.messages.find(
          message => message.senderId !== listing.userId,
        );

        if (!firstFromOther) continue;

        const firstReply = conversation.messages.find(
          message => message.senderId === listing.userId && message.sentAt > firstFromOther.sentAt,
        );

        if (!firstReply) continue;

        gaps.push((firstReply.sentAt.getTime() - firstFromOther.sentAt.getTime()) / 60_000);
      }

      if (!gaps.length) continue;

      gaps.sort((a, b) => a - b);

      const median = Math.round(gaps[Math.floor(gaps.length / 2)]);

      await this.database.professionalListing.update({
        where: { id: listing.id },
        data: { medianResponseMinutes: median },
      });

      updated += 1;
    }

    return updated;
  }
}
