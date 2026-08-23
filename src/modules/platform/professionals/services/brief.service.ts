import { Injectable } from '@nestjs/common';
import {
  BriefState,
  ListingVerificationStatus,
  ManagedRequestSubject,
  SystemMessageType,
  TaxonomyKind,
  ThreadContextType,
  ThreadKind,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException, money } from '@/common';
import {
  CityService,
  MediaService,
  TaxonomyService,
  authorSelect,
  toAuthorView,
  toCityView,
  toTermView,
} from '../../shared';
import { SmartMatchService } from '../../intelligence/services/smart-match.service';
import { ConversationFactoryService } from '../../messaging/services/conversation-factory.service';
import { ReputationService } from '../../trust/services/reputation.service';
import { ChooseMatchDto, CreateBriefDto } from '../dtos/booking.dto';
import { BookingService } from './booking.service';

export const BRIEF_MEDIA_OWNER = 'MANAGED_BRIEF';

@Injectable()
export class BriefService {
  constructor(
    private readonly database: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly cities: CityService,
    private readonly media: MediaService,
    private readonly matcher: SmartMatchService,
    private readonly reputation: ReputationService,
    private readonly conversations: ConversationFactoryService,
    private readonly bookings: BookingService,
  ) {}

  // ─── 2.8.1 Create ──────────────────────────────────────────────────────────

  async create(userId: string, dto: CreateBriefDto) {
    await this.taxonomy.assertValid(TaxonomyKind.PROFESSION, dto.categoryCode, 'categoryCode');

    const cityId = dto.cityId ?? (await this.profileCityId(userId));

    if (cityId) await this.cities.assertValid(cityId);

    const media = await this.media.validate(dto.mediaIds, userId);

    const brief = await this.database.$transaction(async tx => {
      const created = await tx.managedBrief.create({
        data: {
          userId,
          categoryCode: dto.categoryCode,
          description: dto.description,
          urgency: dto.urgency ?? undefined,
          budget: dto.budget ?? null,
          cityId: cityId ?? null,
          state: BriefState.OPEN,
        },
      });

      await this.media.attach(tx, media, BRIEF_MEDIA_OWNER, created.id);

      return created;
    });

    return this.toView(brief);
  }

  async findOne(userId: string, id: string) {
    return this.toView(await this.load(userId, id));
  }

  // ─── 2.8.2 Matches ─────────────────────────────────────────────────────────

  /**
   * The three-match screen.
   *
   * Zero matches is not an empty screen: it returns `matches: []` with
   * `fallback: MANUAL_PLACEMENT`, and the client converts to the human route
   * (2.8.2). A managed promise that silently produces nothing is worse than one
   * that hands the member to a person.
   */
  async matches(userId: string, id: string) {
    const brief = await this.load(userId, id);
    const city = brief.cityId ? await this.cities.find(brief.cityId) : null;

    const candidates = await this.database.professionalListing.findMany({
      where: {
        deletedAt: null,
        isAcceptingWork: true,
        userId: { not: userId },
        verificationStatus: { not: ListingVerificationStatus.DRAFT },
        categories: { some: { code: brief.categoryCode } },
      },
      include: {
        user: { select: authorSelect },
        city: { select: { id: true, name: true, region: true, latitude: true, longitude: true } },
        categories: true,
      },
      take: 100,
    });

    if (!candidates.length) {
      return { briefId: brief.id, matches: [], shortlistSize: 0, fallback: 'MANUAL_PLACEMENT' };
    }

    const [summaries, similarJobs] = await Promise.all([
      this.reputation.summariesFor(candidates.map(row => row.userId)),
      this.similarJobCounts(candidates.map(row => row.id)),
    ]);

    const scored = this.matcher.match(
      {
        categoryCode: brief.categoryCode,
        cityId: brief.cityId,
        latitude: city?.latitude ?? null,
        longitude: city?.longitude ?? null,
        budget: brief.budget,
        urgency: brief.urgency,
      },
      candidates.map(row => {
        const summary = summaries.get(row.userId)!;

        return {
          listingId: row.id,
          userId: row.userId,
          professionTitle: row.professionTitle,
          ratingAverage: summary.average,
          ratingCount: summary.countedTotal,
          jobsCompleted: row.jobsCompleted,
          medianResponseMinutes: row.medianResponseMinutes,
          priceFrom: row.priceFrom,
          cityId: row.cityId,
          latitude: row.city?.latitude ?? null,
          longitude: row.city?.longitude ?? null,
          isAcceptingWork: row.isAcceptingWork,
          similarJobs: similarJobs.get(row.id) ?? 0,
        };
      }),
    );

    // Persisted, so the shortlist a member saw is the shortlist they chose from
    // rather than one recomputed under them on the next screen.
    await this.database.$transaction(async tx => {
      await tx.briefMatch.deleteMany({ where: { briefId: brief.id } });
      await tx.briefMatch.createMany({
        data: scored.map(match => ({
          briefId: brief.id,
          listingId: match.listingId,
          rank: match.rank,
          totalScore: match.totalScore,
          ratingScore: match.scores.rating.value,
          distanceScore: match.scores.distance.value,
          priceScore: match.scores.price.value,
          responseScore: match.scores.response.value,
          priceForBrief: match.priceForBrief,
          rationale: match.rationale,
        })),
      });

      await tx.managedBrief.update({
        where: { id: brief.id },
        data: { state: BriefState.MATCHED },
      });
    });

    const professionLabels = await this.taxonomy.labels(TaxonomyKind.PROFESSION);
    const byId = new Map(candidates.map(row => [row.id, row] as const));

    return {
      briefId: brief.id,
      matches: scored.map(match => {
        const listing = byId.get(match.listingId)!;
        const summary = summaries.get(listing.userId)!;

        return {
          professional: {
            type: 'PROFESSIONAL' as const,
            id: listing.id,
            user: toAuthorView(listing.user),
            professionTitle: listing.professionTitle,
            category: toTermView(listing.categories[0]?.code ?? null, professionLabels),
            city: toCityView(listing.city),
            rating: {
              average: summary.average,
              count: summary.countedTotal,
              excludedCount: summary.excludedTotal,
            },
            medianResponseMinutes: listing.medianResponseMinutes,
            priceFrom: money(listing.priceFrom, listing.currency),
            priceBasis: listing.priceBasis,
            isAcceptingWork: listing.isAcceptingWork,
            trustChecks: toAuthorView(listing.user).trustChecks,
            isImmigrantFriendly: summary.isImmigrantFriendly,
          },
          priceForBrief: money(match.priceForBrief, listing.currency),
          scores: match.scores,
          rationale: match.rationale,
        };
      }),
      shortlistSize: scored.length,
      ...(scored.length === 0 ? { fallback: 'MANUAL_PLACEMENT' } : {}),
    };
  }

  // ─── 2.8.3 Choose ──────────────────────────────────────────────────────────

  /**
   * Creates the booking FROM the brief and returns it. The client does not then
   * call POST /bookings as well (2.8.3) — which is what stops the brief text
   * being posted twice.
   */
  async choose(userId: string, id: string, dto: ChooseMatchDto) {
    const brief = await this.load(userId, id);

    if (brief.state === BriefState.PLACED && brief.bookingId) {
      throw ApiException.conflict(
        ApiErrorCode.CONFLICT,
        'You have already chosen someone for this brief.',
        { data: { bookingId: brief.bookingId } },
      );
    }

    const listing = await this.database.professionalListing.findUnique({
      where: { id: dto.listingId },
    });

    if (!listing || listing.deletedAt) {
      throw ApiException.notFound(
        'That professional could not be found.',
        ApiErrorCode.LISTING_NOT_FOUND,
      );
    }

    // The booking is created here, from the brief, and returned. The server
    // copies the description, urgency and budget across, so the client never
    // re-posts the brief text on a booking call (2.1.5).
    return this.bookings.create(userId, { listingId: listing.id, briefId: brief.id });
  }

  // ─── 2.8.4 Manual placement ────────────────────────────────────────────────

  /** The human fallback the managed promise implies. Opens a Circl-team thread. */
  async manualPlacement(userId: string, id: string) {
    const brief = await this.load(userId, id);
    const staffIds = await this.conversations.staffUserIds();

    const result = await this.database.$transaction(async tx => {
      const { conversation, created } = await this.conversations.ensure(
        {
          kind: ThreadKind.SUPPORT,
          participantIds: [userId],
          staffIds,
          contextType: ThreadContextType.BRIEF,
          contextId: brief.id,
          snapshot: { title: 'Finding you someone', subtitle: brief.description.slice(0, 80) },
          isPinned: true,
        },
        tx,
      );

      if (created) {
        await this.conversations.postSystemMessage(
          conversation.id,
          SystemMessageType.BRIEF_ATTACHED,
          "Circl's team has your brief and will find someone for you. Only Circl staff can see this thread.",
          { briefId: brief.id },
          tx,
        );
      }

      await tx.managedRequest.create({
        data: {
          userId,
          subjectType: ManagedRequestSubject.PROFESSIONAL_PLACEMENT,
          briefId: brief.id,
          conversationId: conversation.id,
        },
      });

      return conversation;
    });

    return { conversationId: result.id };
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /** Similar jobs completed, which is the honest half of the rationale sentence. */
  private async similarJobCounts(listingIds: string[]): Promise<Map<string, number>> {
    if (!listingIds.length) return new Map();

    const grouped = await this.database.booking.groupBy({
      by: ['listingId'],
      where: { listingId: { in: listingIds }, state: 'COMPLETED' },
      _count: { _all: true },
    });

    return new Map(grouped.map(row => [row.listingId, row._count._all] as const));
  }

  private async load(userId: string, id: string) {
    const brief = await this.database.managedBrief.findUnique({ where: { id } });

    if (!brief || brief.userId !== userId) {
      throw ApiException.notFound('That brief could not be found.');
    }

    return brief;
  }

  private async toView(brief: {
    id: string;
    categoryCode: string;
    description: string;
    urgency: string;
    budget: number | null;
    currency: string;
    cityId: string | null;
    state: BriefState;
    createdAt: Date;
  }) {
    const [labels, city] = await Promise.all([
      this.taxonomy.labels(TaxonomyKind.PROFESSION),
      brief.cityId ? this.cities.find(brief.cityId) : null,
    ]);

    return {
      id: brief.id,
      category: toTermView(brief.categoryCode, labels),
      description: brief.description,
      urgency: brief.urgency,
      budget: money(brief.budget, brief.currency),
      city: toCityView(city),
      state: brief.state,
      createdAt: brief.createdAt.toISOString(),
    };
  }

  private async profileCityId(userId: string): Promise<string | null> {
    const profile = await this.database.userProfile.findUnique({
      where: { userId },
      select: { cityId: true },
    });

    return profile?.cityId ?? null;
  }
}
