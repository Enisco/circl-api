import { Injectable } from '@nestjs/common';
import {
  ActivitySubject,
  ActivityVerb,
  FeedItemType,
  Media,
  PostVisibility,
  Prisma,
  RequestStatus,
  TaxonomyKind,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { CursorMeta, daysAgo, decodeCursor, encodeCursor } from '@/common';
import {
  ActivityService,
  AuthorSource,
  BlockingService,
  MediaService,
  TaxonomyService,
  authorSelect,
  toAuthorView,
} from '../../shared';
import {
  FeedRankerService,
  RankableItem,
  RankingSignal,
  ViewerSignals,
} from '../../intelligence/services/feed-ranker.service';
import { FeedQueryDto, LessLikeThisDto } from '../dtos/feed.dto';
import { toRequestSummary, RequestRow } from '../serializers/request.serializer';
import { toOfferSummary, OfferRow } from '../serializers/offer.serializer';
import { OFFER_MEDIA_OWNER } from './offer.service';
import { REQUEST_MEDIA_OWNER } from './request.service';
import { UPDATE_MEDIA_OWNER } from './update.service';

interface FeedCursor extends Record<string, unknown> {
  /** The rank position already served, for PERSONALISED. */
  offset: number;
  /** The oldest createdAt already served, for LATEST. */
  before?: string;
  ranking: 'PERSONALISED' | 'LATEST';
}

/**
 * How many candidates are pulled per type before ranking.
 *
 * A ranked feed cannot be paged in the database, because the ordering does not
 * exist there. So a window is pulled, ranked in memory, and paged over — which is
 * correct as long as the window is comfortably larger than any page a client
 * will ask for.
 */
const CANDIDATE_WINDOW = 120;

/** How far back PERSONALISED looks. Beyond this a post is history, not a feed. */
const CANDIDATE_DAYS = 45;

@Injectable()
export class FeedService {
  constructor(
    private readonly database: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly media: MediaService,
    private readonly blocking: BlockingService,
    private readonly activity: ActivityService,
    private readonly ranker: FeedRankerService,
  ) {}

  /**
   * `GET /community/feed` (1.1).
   *
   * One merged, ranked, cursor-paged stream of Requests, Offers, Updates and
   * occasionally a Guide. Cursor rather than page numbers because the underlying
   * data shifts while the member reads, and page-based paging duplicates and
   * drops items when it does (0.5).
   */
  async feed(viewerId: string, query: FeedQueryDto) {
    const limit = Math.min(query.limit ?? 20, 50);
    const cursor = decodeCursor<FeedCursor>(query.cursor);
    const profile = await this.profileOf(viewerId);

    // PERSONALISED once the member has completed interests onboarding, else
    // LATEST — but an explicit choice always wins, because ranking that cannot be
    // switched off is ranking that stops being trusted (1.1).
    const ranking =
      query.ranking ?? cursor?.ranking ?? (profile.hasInterests ? 'PERSONALISED' : 'LATEST');

    const blockedIds = await this.blocking.blockedUserIds(viewerId);
    const cityId = this.resolveCity(query.cityId, profile.cityId);

    // Selecting any category excludes UPDATE items, which have no category. A
    // client-side product rule the server honours so paging stays consistent.
    const requestedTypes = new Set(query.types?.length ? query.types : Object.values(FeedItemType));

    if (query.categories?.length) requestedTypes.delete(FeedItemType.UPDATE);

    const [requests, offers, updates, guides] = await Promise.all([
      requestedTypes.has(FeedItemType.REQUEST)
        ? this.candidateRequests(query, cityId, blockedIds, ranking)
        : [],
      requestedTypes.has(FeedItemType.OFFER)
        ? this.candidateOffers(query, cityId, blockedIds, ranking)
        : [],
      requestedTypes.has(FeedItemType.UPDATE)
        ? this.candidateUpdates(cityId, blockedIds, ranking)
        : [],
      requestedTypes.has(FeedItemType.GUIDE) ? this.candidateGuides(cityId, ranking) : [],
    ]);

    const rankable: RankableItem[] = [
      ...requests.map(row => ({
        type: FeedItemType.REQUEST,
        id: row.id,
        createdAt: row.createdAt,
        cityId: row.cityId,
        categoryCode: row.categoryCode,
        engagement: row.replyCount + row.helperCount * 2,
        neededOn: row.neededOn,
        authorId: row.authorId,
      })),
      ...offers.map(row => ({
        type: FeedItemType.OFFER,
        id: row.id,
        createdAt: row.createdAt,
        cityId: row.cityId,
        categoryCode: row.categoryCode,
        engagement: row.viewCount,
        authorId: row.authorId,
      })),
      ...updates.map(row => ({
        type: FeedItemType.UPDATE,
        id: row.id,
        createdAt: row.createdAt,
        cityId: row.cityId,
        categoryCode: null,
        engagement: row.reactionCount + row.replyCount,
        authorId: row.authorId,
      })),
      ...guides.map(row => ({
        type: FeedItemType.GUIDE,
        id: row.id,
        createdAt: row.publishedAt ?? row.createdAt,
        cityId: row.cityId,
        categoryCode: row.topicCode,
        engagement: Math.round(row.likeCount + row.viewCount / 20),
        authorId: row.authorId ?? '',
      })),
    ];

    const signals = await this.viewerSignals(viewerId, profile);

    const ordered =
      ranking === 'PERSONALISED'
        ? this.ranker.rank(rankable, signals)
        : rankable
            .filter(item => !signals.suppressed.has(item.id))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .map(item => ({ item, score: 0, signals: [] as RankingSignal[], reason: null }));

    const offset = cursor?.offset ?? 0;
    const page = ordered.slice(offset, offset + limit);
    const hasNextPage = ordered.length > offset + limit;

    const data = await this.serialise(page, viewerId, profile.cityId, ranking, blockedIds, {
      requests,
      offers,
      updates,
      guides,
    });

    const meta: CursorMeta = {
      nextCursor: hasNextPage
        ? encodeCursor({ offset: offset + limit, ranking } satisfies FeedCursor)
        : null,
      hasNextPage,
      // Null for cursor responses: a total over a ranked, personalised feed is
      // both expensive and meaningless (0.5).
      totalCount: null,
      ranking,
    };

    return { data, meta, message: 'Feed loaded' };
  }

  /**
   * "Show me less like this" (1.1). Suppresses the card for this member and feeds
   * the ranking signal. Returns 204; the client removes the card optimistically.
   */
  async lessLikeThis(userId: string, itemId: string, dto: LessLikeThisDto): Promise<void> {
    await this.database.feedFeedback.upsert({
      where: { userId_itemType_itemId: { userId, itemType: dto.type, itemId } },
      update: { reason: dto.reason ?? null },
      create: { userId, itemType: dto.type, itemId, reason: dto.reason ?? null },
    });

    this.activity.record({
      userId,
      verb: ActivityVerb.DISMISS,
      subject: this.subjectFor(dto.type),
      subjectId: itemId,
      metadata: { reason: dto.reason },
    });
  }

  // ─── Candidates ────────────────────────────────────────────────────────────

  private candidateRequests(
    query: FeedQueryDto,
    cityId: string | null,
    blockedIds: string[],
    ranking: 'PERSONALISED' | 'LATEST',
  ) {
    const where: Prisma.CommunityRequestWhereInput = {
      deletedAt: null,
      visibility: { not: PostVisibility.PRIVATE_TO_CIRCL },
      // Applies to REQUEST items only, and defaults to OPEN.
      status: query.status ?? RequestStatus.OPEN,
      ...(cityId ? { cityId } : {}),
      ...(query.categories?.length ? { categoryCode: { in: query.categories } } : {}),
      ...(blockedIds.length ? { authorId: { notIn: blockedIds } } : {}),
      ...(ranking === 'PERSONALISED' ? { createdAt: { gte: daysAgo(CANDIDATE_DAYS) } } : {}),
    };

    return this.database.communityRequest.findMany({
      where,
      include: {
        author: { select: authorSelect },
        city: { select: { id: true, name: true, region: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: CANDIDATE_WINDOW,
    });
  }

  private candidateOffers(
    query: FeedQueryDto,
    cityId: string | null,
    blockedIds: string[],
    ranking: 'PERSONALISED' | 'LATEST',
  ) {
    return this.database.communityOffer.findMany({
      where: {
        deletedAt: null,
        promotedToListingId: null,
        ...(cityId ? { cityId } : {}),
        ...(query.categories?.length ? { categoryCode: { in: query.categories } } : {}),
        ...(blockedIds.length ? { authorId: { notIn: blockedIds } } : {}),
        // Offers are evergreen, so LATEST would otherwise bury requests under
        // months of them. The window stays wide and D3's decay does the work.
        ...(ranking === 'PERSONALISED' ? { createdAt: { gte: daysAgo(CANDIDATE_DAYS * 4) } } : {}),
      },
      include: {
        author: { select: authorSelect },
        city: { select: { id: true, name: true, region: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: Math.floor(CANDIDATE_WINDOW / 2),
    });
  }

  private candidateUpdates(
    cityId: string | null,
    blockedIds: string[],
    ranking: 'PERSONALISED' | 'LATEST',
  ) {
    return this.database.communityUpdate.findMany({
      where: {
        deletedAt: null,
        ...(cityId ? { cityId } : {}),
        ...(blockedIds.length ? { authorId: { notIn: blockedIds } } : {}),
        ...(ranking === 'PERSONALISED' ? { createdAt: { gte: daysAgo(CANDIDATE_DAYS) } } : {}),
      },
      include: {
        author: { select: authorSelect },
        city: { select: { id: true, name: true, region: true } },
        tags: { include: { user: { select: authorSelect } } },
      },
      orderBy: { createdAt: 'desc' },
      take: CANDIDATE_WINDOW,
    });
  }

  /**
   * "and (occasionally) a Guide" (1.1). A handful of the best, not a stream:
   * guides are long-form and evergreen, and a feed that fills with them stops
   * being a feed of what is happening.
   */
  private candidateGuides(cityId: string | null, ranking: 'PERSONALISED' | 'LATEST') {
    return this.database.guide.findMany({
      where: {
        deletedAt: null,
        publishedAt: { not: null },
        ...(cityId ? { OR: [{ cityId }, { cityId: null }] } : {}),
      },
      include: {
        author: { select: authorSelect },
        city: { select: { id: true, name: true, region: true } },
      },
      orderBy: ranking === 'LATEST' ? { publishedAt: 'desc' } : [{ viewCount: 'desc' }],
      take: 8,
    });
  }

  // ─── Serialisation ─────────────────────────────────────────────────────────

  private async serialise(
    page: Array<{ item: RankableItem; signals: RankingSignal[]; reason: string | null }>,
    viewerId: string,
    viewerCityId: string | null,
    ranking: 'PERSONALISED' | 'LATEST',
    blockedIds: string[],
    pools: {
      requests: RequestRow[];
      offers: OfferRow[];
      updates: Awaited<ReturnType<FeedService['candidateUpdates']>>;
      guides: Awaited<ReturnType<FeedService['candidateGuides']>>;
    },
  ) {
    const idsByType = new Map<FeedItemType, string[]>();

    for (const entry of page) {
      const list = idsByType.get(entry.item.type) ?? [];

      list.push(entry.item.id);
      idsByType.set(entry.item.type, list);
    }

    const [categoryLabels, topicLabels, requestMedia, offerMedia, updateMedia, viewerState] =
      await Promise.all([
        this.taxonomy.labels(TaxonomyKind.COMMUNITY_CATEGORY),
        this.taxonomy.labels(TaxonomyKind.GUIDE_TOPIC),
        this.media.forOwners(REQUEST_MEDIA_OWNER, idsByType.get(FeedItemType.REQUEST) ?? []),
        this.media.forOwners(OFFER_MEDIA_OWNER, idsByType.get(FeedItemType.OFFER) ?? []),
        this.media.forOwners(UPDATE_MEDIA_OWNER, idsByType.get(FeedItemType.UPDATE) ?? []),
        this.viewerState(viewerId, idsByType),
      ]);

    const requestsById = new Map(pools.requests.map(row => [row.id, row]));
    const offersById = new Map(pools.offers.map(row => [row.id, row]));
    const updatesById = new Map(pools.updates.map(row => [row.id, row]));
    const guidesById = new Map(pools.guides.map(row => [row.id, row]));
    const blockedSet = new Set(blockedIds);

    return page
      .map(entry => {
        // `ranking` is present only when PERSONALISED, and omitted entirely
        // rather than carrying a placeholder reason (D7).
        const rankingBlock =
          ranking === 'PERSONALISED' && entry.reason
            ? { ranking: { reason: entry.reason, signals: entry.signals } }
            : {};

        switch (entry.item.type) {
          case FeedItemType.REQUEST: {
            const row = requestsById.get(entry.item.id);

            if (!row) return null;

            return {
              ...toRequestSummary(row, {
                viewerId,
                viewerCityId,
                categoryLabels,
                media: requestMedia,
                hasOffered: viewerState.offered,
                blockedAuthorIds: blockedSet,
              }),
              ...rankingBlock,
            };
          }

          case FeedItemType.OFFER: {
            const row = offersById.get(entry.item.id);

            if (!row) return null;

            return {
              ...toOfferSummary(row, {
                viewerId,
                categoryLabels,
                media: offerMedia,
                blockedAuthorIds: blockedSet,
              }),
              ...rankingBlock,
            };
          }

          case FeedItemType.UPDATE: {
            const row = updatesById.get(entry.item.id);

            if (!row) return null;

            const isOwner = row.authorId === viewerId;

            return {
              type: 'UPDATE' as const,
              id: row.id,
              content: row.content,
              media: this.mediaViews(updateMedia.get(row.id)),
              city: row.city
                ? { id: row.city.id, name: row.city.name, region: row.city.region }
                : null,
              counts: {
                ...(row.reactionCountHidden && !isOwner ? {} : { reactions: row.reactionCount }),
                replies: row.replyCount,
              },
              commentsEnabled: row.commentsEnabled,
              reactionCountHidden: row.reactionCountHidden,
              author: this.authorOf(row),
              visibility: row.visibility,
              viewer: { isOwner, hasLiked: viewerState.liked.has(row.id) },
              createdAt: row.createdAt.toISOString(),
              ...rankingBlock,
            };
          }

          case FeedItemType.GUIDE: {
            const row = guidesById.get(entry.item.id);

            if (!row) return null;

            return {
              type: 'GUIDE' as const,
              id: row.id,
              title: row.title,
              topic: {
                code: row.topicCode,
                label: topicLabels.get(row.topicCode) ?? row.topicCode,
              },
              intro: row.intro,
              city: row.city
                ? { id: row.city.id, name: row.city.name, region: row.city.region }
                : null,
              readTimeMinutes: row.readTimeMinutes,
              counts: { views: row.viewCount, likes: row.likeCount },
              author: this.authorOf(row),
              isAutoGenerated: row.isAutoGenerated,
              viewer: {
                isBookmarked: viewerState.bookmarked.has(row.id),
                hasLiked: viewerState.likedGuides.has(row.id),
              },
              publishedAt: row.publishedAt?.toISOString() ?? null,
              ...rankingBlock,
            };
          }

          default:
            return null;
        }
      })
      .filter(Boolean);
  }

  private mediaViews(media: Media[] | undefined) {
    return (media ?? [])
      .sort((a, b) => a.position - b.position)
      .map(item => ({
        id: item.id,
        type: item.type,
        url: item.url,
        thumbnailUrl: item.thumbnailUrl,
        width: item.width,
        height: item.height,
        blurHash: item.blurHash,
      }));
  }

  private authorOf(row: { author: AuthorSource | null; visibility?: PostVisibility }) {
    return toAuthorView(row.author, { isAnonymous: row.visibility === PostVisibility.ANONYMOUS });
  }

  private async viewerState(viewerId: string, idsByType: Map<FeedItemType, string[]>) {
    const requestIds = idsByType.get(FeedItemType.REQUEST) ?? [];
    const updateIds = idsByType.get(FeedItemType.UPDATE) ?? [];
    const guideIds = idsByType.get(FeedItemType.GUIDE) ?? [];

    const [offers, likes, bookmarks, guideLikes] = await Promise.all([
      requestIds.length
        ? this.database.requestResponse.findMany({
            where: {
              requestId: { in: requestIds },
              authorId: viewerId,
              isHelpOffer: true,
              deletedAt: null,
            },
            select: { requestId: true },
          })
        : [],
      updateIds.length
        ? this.database.updateReaction.findMany({
            where: { updateId: { in: updateIds }, userId: viewerId },
            select: { updateId: true },
          })
        : [],
      guideIds.length
        ? this.database.guideBookmark.findMany({
            where: { guideId: { in: guideIds }, userId: viewerId },
            select: { guideId: true },
          })
        : [],
      guideIds.length
        ? this.database.guideReaction.findMany({
            where: { guideId: { in: guideIds }, userId: viewerId },
            select: { guideId: true },
          })
        : [],
    ]);

    return {
      offered: new Set(offers.map(row => row.requestId)),
      liked: new Set(likes.map(row => row.updateId)),
      bookmarked: new Set(bookmarks.map(row => row.guideId)),
      likedGuides: new Set(guideLikes.map(row => row.guideId)),
    };
  }

  // ─── Viewer signals ────────────────────────────────────────────────────────

  private async profileOf(viewerId: string) {
    const profile = await this.database.userProfile.findUnique({
      where: { userId: viewerId },
      select: { cityId: true, journeyStage: true, interests: true },
    });

    const interests = Array.isArray(profile?.interests) ? (profile.interests as string[]) : [];

    return {
      cityId: profile?.cityId ?? null,
      journeyStage: profile?.journeyStage ?? null,
      interests,
      hasInterests: interests.length > 0,
    };
  }

  /**
   * The behavioural half of the ranking input: which categories this member has
   * actually engaged with, and what they asked to stop seeing.
   */
  private async viewerSignals(
    viewerId: string,
    profile: { cityId: string | null; journeyStage: string | null; interests: string[] },
  ): Promise<ViewerSignals> {
    const [events, suppressed] = await Promise.all([
      this.database.activityEvent.groupBy({
        by: ['code'],
        where: {
          userId: viewerId,
          code: { not: null },
          occurredAt: { gte: daysAgo(90) },
        },
        _sum: { weight: true },
      }),
      this.database.feedFeedback.findMany({
        where: { userId: viewerId },
        select: { itemId: true },
      }),
    ]);

    return {
      cityId: profile.cityId,
      journeyStage: profile.journeyStage,
      interests: profile.interests,
      affinity: new Map(events.map(row => [row.code!, row._sum.weight ?? 0])),
      suppressed: new Set(suppressed.map(row => row.itemId)),
    };
  }

  private resolveCity(requested: string | undefined, profileCityId: string | null): string | null {
    if (requested === 'ANYWHERE') return null;

    return requested ?? profileCityId;
  }

  private subjectFor(type: FeedItemType): ActivitySubject {
    switch (type) {
      case FeedItemType.REQUEST:
        return ActivitySubject.REQUEST;
      case FeedItemType.OFFER:
        return ActivitySubject.OFFER;
      case FeedItemType.UPDATE:
        return ActivitySubject.UPDATE;
      default:
        return ActivitySubject.GUIDE;
    }
  }
}
