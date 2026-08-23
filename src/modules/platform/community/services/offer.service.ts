import { Injectable } from '@nestjs/common';
import {
  ActivitySubject,
  ActivityVerb,
  CommunityOffer,
  ListingVerificationStatus,
  Prisma,
  TaxonomyKind,
  ThreadContextType,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException, buildPageMeta, Paginated } from '@/common';
import {
  ActivityService,
  BlockingService,
  CityService,
  MediaService,
  TaxonomyService,
  authorSelect,
} from '../../shared';
import { CreateOfferDto, ListOffersDto, UpdateOfferDto } from '../dtos/offer.dto';
import {
  OfferDetailView,
  OfferRow,
  OfferSummaryView,
  OfferViewContext,
  toOfferDetail,
  toOfferSummary,
} from '../serializers/offer.serializer';

export const OFFER_MEDIA_OWNER = 'COMMUNITY_OFFER';

const offerInclude = {
  author: { select: authorSelect },
  city: { select: { id: true, name: true, region: true } },
} satisfies Prisma.CommunityOfferInclude;

@Injectable()
export class OfferService {
  constructor(
    private readonly database: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly cities: CityService,
    private readonly media: MediaService,
    private readonly blocking: BlockingService,
    private readonly activity: ActivityService,
  ) {}

  async list(viewerId: string, query: ListOffersDto): Promise<Paginated<OfferSummaryView>> {
    const blockedIds = await this.blocking.blockedUserIds(viewerId);
    const where = await this.buildWhere(query, blockedIds);

    const [total, rows] = await this.database.$transaction([
      this.database.communityOffer.count({ where }),
      this.database.communityOffer.findMany({
        where,
        include: offerInclude,
        orderBy: [{ createdAt: 'desc' }],
        skip: query.skip,
        take: query.take,
      }),
    ]);

    const context = await this.buildContext(rows, viewerId, blockedIds);

    return {
      data: rows.map(row => toOfferSummary(row, context)),
      meta: buildPageMeta(query, total),
    };
  }

  async findOne(viewerId: string, id: string): Promise<OfferDetailView> {
    const offer = await this.database.communityOffer.findUnique({
      where: { id },
      include: offerInclude,
    });

    if (!offer) throw ApiException.notFound('This offer could not be found.');
    if (offer.deletedAt) throw ApiException.deleted('This offer');

    if (await this.activity.countView('offer', id, viewerId, offer.authorId)) {
      await this.database.communityOffer.update({
        where: { id },
        data: { viewCount: { increment: 1 } },
      });
    }

    this.activity.record({
      userId: viewerId,
      verb: ActivityVerb.VIEW,
      subject: ActivitySubject.OFFER,
      subjectId: id,
      cityId: offer.cityId,
      code: offer.categoryCode,
    });

    const blockedIds = await this.blocking.blockedUserIds(viewerId);
    const context = await this.buildContext([offer], viewerId, blockedIds, true);

    return toOfferDetail(offer, context);
  }

  async create(userId: string, dto: CreateOfferDto): Promise<OfferDetailView> {
    await this.taxonomy.assertValid(
      TaxonomyKind.COMMUNITY_CATEGORY,
      dto.categoryCode,
      'categoryCode',
    );
    await this.cities.assertValid(dto.cityId);

    const media = await this.media.validate(dto.mediaIds, userId);

    const offer = await this.database.$transaction(async tx => {
      const created = await tx.communityOffer.create({
        data: {
          authorId: userId,
          title: dto.title,
          description: dto.description,
          categoryCode: dto.categoryCode,
          cityId: dto.cityId,
          deliveryMode: dto.deliveryMode ?? undefined,
          priceFrom: dto.priceFrom ?? null,
          priceBasis: dto.priceBasis ?? undefined,
        },
      });

      await this.media.attach(tx, media, OFFER_MEDIA_OWNER, created.id);

      return created;
    });

    this.activity.record({
      userId,
      verb: ActivityVerb.CREATE,
      subject: ActivitySubject.OFFER,
      subjectId: offer.id,
      cityId: offer.cityId,
      code: offer.categoryCode,
      term: offer.title,
      weight: 3,
    });

    return this.findOne(userId, offer.id);
  }

  async update(userId: string, id: string, dto: UpdateOfferDto): Promise<OfferDetailView> {
    const offer = await this.load(id);

    this.assertOwner(offer, userId);

    if (dto.categoryCode) {
      await this.taxonomy.assertValid(
        TaxonomyKind.COMMUNITY_CATEGORY,
        dto.categoryCode,
        'categoryCode',
      );
    }

    if (dto.cityId) await this.cities.assertValid(dto.cityId);

    const media = dto.mediaIds ? await this.media.validate(dto.mediaIds, userId) : null;

    await this.database.$transaction(async tx => {
      await tx.communityOffer.update({
        where: { id },
        data: {
          title: dto.title,
          description: dto.description,
          categoryCode: dto.categoryCode,
          cityId: dto.cityId,
          deliveryMode: dto.deliveryMode,
          priceFrom: dto.priceFrom,
          priceBasis: dto.priceBasis,
        },
      });

      if (media) {
        await this.media.releaseOwner(tx, OFFER_MEDIA_OWNER, id);
        await this.media.attach(tx, media, OFFER_MEDIA_OWNER, id);
      }
    });

    return this.findOne(userId, id);
  }

  async remove(userId: string, id: string): Promise<void> {
    const offer = await this.load(id);

    this.assertOwner(offer, userId);

    await this.database.communityOffer.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async buildWhere(
    query: ListOffersDto,
    blockedIds: string[],
  ): Promise<Prisma.CommunityOfferWhereInput> {
    const where: Prisma.CommunityOfferWhereInput = { deletedAt: null };

    const city = await this.cities.resolve(query.cityId, query.city);

    if (city) where.cityId = city.id;

    if (query.categories?.length) {
      const known = await this.taxonomy.knownCodes(
        TaxonomyKind.COMMUNITY_CATEGORY,
        query.categories,
      );

      where.categoryCode = { in: known.length ? known : ['__NONE__'] };
    }

    if (query.deliveryMode) where.deliveryMode = query.deliveryMode;
    if (query.authorId) where.authorId = query.authorId;

    // freeOnly and maxPrice are different questions: "costs nothing" and "costs at
    // most this". A free offer satisfies maxPrice too, which is why the null is
    // included rather than filtered out by a bare numeric comparison.
    if (query.freeOnly) {
      where.priceFrom = null;
    } else if (query.maxPrice !== undefined) {
      where.OR = [{ priceFrom: null }, { priceFrom: { lte: query.maxPrice } }];
    }

    if (query.q) {
      const search = [
        { title: { contains: query.q, mode: Prisma.QueryMode.insensitive } },
        { description: { contains: query.q, mode: Prisma.QueryMode.insensitive } },
      ];

      where.AND = [...(Array.isArray(where.AND) ? where.AND : []), { OR: search }];
    }

    // An offer promoted into a VERIFIED professional listing leaves the community
    // list, so the same person is not listed twice for the same service (2.1.3).
    // Until the listing is verified, both stay live, which is what lets a member
    // keep helping while their listing is in review.
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : []),
      {
        OR: [
          { promotedToListingId: null },
          {
            promotedToListing: {
              verificationStatus: { not: ListingVerificationStatus.VERIFIED },
            },
          },
        ],
      },
      ...(blockedIds.length ? [{ authorId: { notIn: blockedIds } }] : []),
    ];

    return where;
  }

  private async buildContext(
    rows: OfferRow[],
    viewerId: string | null,
    blockedIds: string[],
    withConversations = false,
  ): Promise<OfferViewContext> {
    const ids = rows.map(row => row.id);
    const [categoryLabels, media] = await Promise.all([
      this.taxonomy.labels(TaxonomyKind.COMMUNITY_CATEGORY),
      this.media.forOwners(OFFER_MEDIA_OWNER, ids),
    ]);

    const context: OfferViewContext = {
      viewerId,
      categoryLabels,
      media,
      blockedAuthorIds: new Set(blockedIds),
    };

    if (withConversations && viewerId && ids.length) {
      const conversations = await this.database.conversation.findMany({
        where: {
          contextType: ThreadContextType.OFFER,
          contextId: { in: ids },
          participants: { some: { userId: viewerId } },
        },
        select: { id: true, contextId: true },
      });

      context.conversationIds = new Map(conversations.map(row => [row.contextId!, row.id]));
    }

    return context;
  }

  private async load(id: string): Promise<CommunityOffer> {
    const offer = await this.database.communityOffer.findUnique({ where: { id } });

    if (!offer) throw ApiException.notFound('This offer could not be found.');
    if (offer.deletedAt) throw ApiException.deleted('This offer');

    return offer;
  }

  private assertOwner(offer: CommunityOffer, userId: string): void {
    if (offer.authorId !== userId) {
      throw ApiException.forbidden(
        ApiErrorCode.FORBIDDEN,
        'Only the person who posted this offer can change it.',
      );
    }
  }
}
