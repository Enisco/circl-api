import { Injectable } from '@nestjs/common';
import { JobState, ListingVerificationStatus, TaxonomyKind } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { daysAgo, money } from '@/common';
import {
  MediaService,
  TaxonomyService,
  authorSelect,
  toAuthorView,
  toCityView,
  toTermView,
} from '../../shared';
import { ReputationService } from '../../trust/services/reputation.service';

/** `GET /professionals/home` (2.2) and `GET /professionals/me/dashboard` (2.11). */
@Injectable()
export class ProfessionalsHomeService {
  constructor(
    private readonly database: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly reputation: ReputationService,
    private readonly media: MediaService,
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
          // At most 3: an in-flight job should never require hunting through a menu to find (2.2).
          take: 3,
        }),
        this.trustCounts(),
      ]);

    const summaries = await this.reputation.summariesFor(nearYou.map(row => row.userId));

    return {
      // Real counts, so an empty category can be handled honestly rather than rendering a tile that leads nowhere.
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
          user: toAuthorView(row.user, { sign: this.media.sign }),
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
      // Null when the member has no listing.
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
          { sign: this.media.sign },
        ),
        state: booking.state,
      })),
      trust,
    };
  }

  /** The trust strip. */
  private async trustCounts() {
    const [verifiedCount, ratedCount, vouchedCount] = await Promise.all([
      this.database.trustCheck.count({ where: { status: 'VERIFIED', check: { not: 'EMAIL' } } }),
      this.database.reputationSummary.count({ where: { countedTotal: { gt: 0 } } }),
      this.database.review.count({ where: { deletedAt: null } }),
    ]);

    return { verifiedCount, vouchedCount, ratedCount };
  }

  // ─── 2.11 Dashboard ────────────────────────────────────────────────────────

  /** `agreedTotal` is the sum of amounts the two parties agreed, not money Circl holds, owes, or has paid. */
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
          state: {
            in: [
              JobState.ACCEPTED,
              JobState.IN_PROGRESS,
              JobState.DELIVERED,
              JobState.CHANGES_REQUESTED,
            ],
          },
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
      // Here so the availability switch can write straight to PATCH /professionals/listings/{id}/availability rather than fetching GET /professionals/me for an id it would otherwise go and look up (2.11).
      listingId: listing.id,
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
        rate: listing.profileViews ? Number((bookingCount / listing.profileViews).toFixed(4)) : 0,
      },
      isAcceptingWork: listing.isAcceptingWork,
    };
  }

  /** Median minutes from the first client message to the professional's first reply, over the last 30 days (2.11). */
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
