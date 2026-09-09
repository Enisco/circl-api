import { Injectable } from '@nestjs/common';
import { ListingVerificationStatus, Prisma, TaxonomyKind, ThreadContextType } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import {
  ApiErrorCode,
  ApiException,
  buildPageMeta,
  distanceMiles,
  escapeLike,
  money,
  PageMeta,
} from '@/common';
import {
  BlockingService,
  MediaService,
  TaxonomyService,
  authorSelect,
  toAuthorView,
  toCityView,
  toTermView,
  isAllCategories,
} from '../../shared';
import { ReputationService } from '../../trust/services/reputation.service';
import { BrowseProfessionalsDto } from '../dtos/browse.dto';
import { ListingService } from './listing.service';

const LISTING_INCLUDE = {
  user: { select: authorSelect },
  city: { select: { id: true, name: true, region: true, latitude: true, longitude: true } },
  categories: true,
} satisfies Prisma.ProfessionalListingInclude;

type ListingRow = Prisma.ProfessionalListingGetPayload<{ include: typeof LISTING_INCLUDE }>;

/** Paging across two blocks only holds if the rows inside each come back in the same order twice. */
const LISTING_ORDER: Prisma.ProfessionalListingOrderByWithRelationInput[] = [
  { createdAt: 'desc' },
  { id: 'asc' },
];

const NOWHERE = { latitude: null, longitude: null };

@Injectable()
export class BrowseService {
  constructor(
    private readonly database: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly reputation: ReputationService,
    private readonly blocking: BlockingService,
    private readonly listings: ListingService,
    private readonly media: MediaService,
  ) {}

  // ─── 2.3 Browse ────────────────────────────────────────────────────────────

  /** D14: `listingType=BOTH` stays a single server-side query. */
  async browse(viewerId: string, query: BrowseProfessionalsDto) {
    const listingType = query.listingType ?? 'PROFESSIONAL';
    const blockedIds = await this.blocking.blockedUserIds(viewerId);
    const viewerCityId = await this.viewerCityId(viewerId);
    const origin =
      query.nearMe && query.latitude !== undefined && query.longitude !== undefined
        ? { latitude: query.latitude, longitude: query.longitude }
        : null;

    const [listings, offers] = await Promise.all([
      listingType === 'COMMUNITY_OFFER'
        ? { rows: [], total: 0, inCityTotal: 0 }
        : this.queryListings(query, viewerCityId, blockedIds, origin),
      listingType === 'PROFESSIONAL'
        ? { rows: [], total: 0 }
        : this.queryOffers(query, viewerCityId, blockedIds),
    ]);

    const items = [...listings.rows, ...offers.rows];

    // With both types in play the two sets are merged and re-paged in memory over one window,
    // which is what keeps the page boundaries honest.
    const sorted = this.applySort(items, query.sort);
    const paged =
      listingType === 'BOTH' ? sorted.slice(query.skip, query.skip + query.take) : sorted;

    const total = listings.total + offers.total;
    const meta: PageMeta = buildPageMeta(query, total);

    // Where the searched city ends, so the list can carry a "nearby" divider without counting rows.
    meta.inCityCount = listings.inCityTotal + offers.total;

    // An empty category is a demand signal, and the member still needs an answer (2.3).
    if (total === 0) {
      meta.nearbyCityMatches = await this.nearbyCityMatches(query, viewerCityId);
    }

    return { data: paged, meta };
  }

  private async queryListings(
    query: BrowseProfessionalsDto,
    viewerCityId: string | null,
    blockedIds: string[],
    origin: { latitude: number; longitude: number } | null,
  ) {
    const where: Prisma.ProfessionalListingWhereInput = {
      deletedAt: null,
      // A DRAFT listing is visible to its owner only, through /professionals/me.
      verificationStatus: { not: ListingVerificationStatus.DRAFT },
      ...(blockedIds.length ? { userId: { notIn: blockedIds } } : {}),
    };

    const category = query.category && !isAllCategories(query.category) ? query.category : null;

    if (category) where.categories = { some: { code: category } };

    const requested = query.cityId ?? (query.nearMe ? null : viewerCityId);
    const anchorCityId = requested && requested !== 'ANYWHERE' ? requested : null;

    if (query.availability) where.isAcceptingWork = true;
    if (query.freeConsultation) where.freeConsultation = true;
    if (query.maxPrice !== undefined) {
      where.OR = [{ priceFrom: null }, { priceFrom: { lte: query.maxPrice } }];
    }
    if (query.maxResponseHours !== undefined) {
      where.medianResponseMinutes = { lte: query.maxResponseHours * 60 };
    }

    if (query.q) {
      // `%` and `_` are ILIKE wildcards; unescaped, `%` matches the whole table (0.5).
      const q = escapeLike(query.q);

      const search: Prisma.ProfessionalListingWhereInput[] = [
        { professionTitle: { contains: q, mode: Prisma.QueryMode.insensitive } },
        { about: { contains: q, mode: Prisma.QueryMode.insensitive } },
        { city: { name: { contains: q, mode: Prisma.QueryMode.insensitive } } },
        { user: { firstName: { contains: q, mode: Prisma.QueryMode.insensitive } } },
        { user: { lastName: { contains: q, mode: Prisma.QueryMode.insensitive } } },
      ];

      where.AND = [...(Array.isArray(where.AND) ? where.AND : []), { OR: search }];
    }

    // Against the maintained summary, rather than aggregating reviews per listing.
    if (query.minRating !== undefined || query.immigrantFriendly) {
      where.user = {
        ...(where.user as Prisma.UserWhereInput),
        reputationSummary: {
          ...(query.minRating !== undefined ? { average: { gte: query.minRating } } : {}),
          ...(query.immigrantFriendly ? { isImmigrantFriendly: true } : {}),
        },
      };
    }

    // `verification` is accepted and not applied (D13): nothing carries a check other than EMAIL,
    // so applying it would empty the screen.

    // BOTH pulls a wide window and re-pages after the merge; otherwise the database pages.
    const window: { skip: number; take: number } =
      query.listingType === 'BOTH'
        ? { skip: 0, take: 200 }
        : { skip: query.skip, take: query.take };

    if (!anchorCityId) {
      const [total, rows] = await this.database.$transaction([
        this.database.professionalListing.count({ where }),
        this.database.professionalListing.findMany({
          where,
          include: LISTING_INCLUDE,
          orderBy: LISTING_ORDER,
          skip: window.skip,
          take: window.take,
        }),
      ]);

      // Nothing was searched for, so nothing is "nearby" and the whole list is the first block.
      return this.hydrate(rows, query, origin, null, total, total);
    }

    return this.pagedFromCityOutwards(where, anchorCityId, window, query, origin);
  }

  /**
   * The searched city first, then the nearest cities that have anybody. One list and one count, so
   * page two continues page one rather than reshuffling it.
   */
  private async pagedFromCityOutwards(
    where: Prisma.ProfessionalListingWhereInput,
    anchorCityId: string,
    window: { skip: number; take: number },
    query: BrowseProfessionalsDto,
    origin: { latitude: number; longitude: number } | null,
  ) {
    const inCityWhere: Prisma.ProfessionalListingWhereInput = { ...where, cityId: anchorCityId };
    const elsewhereWhere: Prisma.ProfessionalListingWhereInput = {
      ...where,
      cityId: { not: anchorCityId },
    };

    const [inCityTotal, grouped] = await Promise.all([
      this.database.professionalListing.count({ where: inCityWhere }),
      this.database.professionalListing.groupBy({
        by: ['cityId'],
        where: elsewhereWhere,
        _count: { _all: true },
      }),
    ]);

    const ranked = await this.citiesByDistance(
      anchorCityId,
      grouped.map(row => ({ cityId: row.cityId, count: row._count._all })),
    );
    const elsewhereTotal = ranked.reduce((sum, city) => sum + city.count, 0);

    const inCityRows =
      window.skip < inCityTotal
        ? await this.database.professionalListing.findMany({
            where: inCityWhere,
            include: LISTING_INCLUDE,
            orderBy: LISTING_ORDER,
            skip: window.skip,
            take: window.take,
          })
        : [];

    const shortfall = window.take - inCityRows.length;
    const elsewhereRows = shortfall
      ? await this.rowsFromNearestCities(
          elsewhereWhere,
          ranked,
          Math.max(0, window.skip - inCityTotal),
          shortfall,
        )
      : [];

    const milesByCity = new Map(ranked.map(city => [city.cityId, city.miles] as const));

    return this.hydrate(
      [...inCityRows, ...elsewhereRows],
      query,
      origin,
      { anchorCityId, milesByCity },
      inCityTotal + elsewhereTotal,
      inCityTotal,
    );
  }

  /** Nearest first. A city without coordinates goes last rather than first, ordered by id. */
  private async citiesByDistance(
    anchorCityId: string,
    cities: { cityId: string; count: number }[],
  ): Promise<{ cityId: string; count: number; miles: number | null }[]> {
    if (!cities.length) return [];

    const rows = await this.database.city.findMany({
      where: { id: { in: [anchorCityId, ...cities.map(city => city.cityId)] } },
      select: { id: true, latitude: true, longitude: true },
    });
    const coordinates = new Map(rows.map(row => [row.id, row] as const));
    const anchor = coordinates.get(anchorCityId);
    const from =
      anchor?.latitude !== null && anchor?.latitude !== undefined && anchor.longitude !== null
        ? { latitude: anchor.latitude, longitude: anchor.longitude }
        : null;

    return cities
      .map(city => ({
        ...city,
        miles: from ? distanceMiles(from, coordinates.get(city.cityId) ?? NOWHERE) : null,
      }))
      .sort((a, b) => {
        if (a.miles === b.miles) return a.cityId.localeCompare(b.cityId);

        return a.miles === null ? 1 : b.miles === null ? -1 : a.miles - b.miles;
      });
  }

  /** Walks outwards until the page is full, skipping whole cities by their counts. */
  private async rowsFromNearestCities(
    where: Prisma.ProfessionalListingWhereInput,
    ranked: { cityId: string; count: number }[],
    skip: number,
    take: number,
  ) {
    const rows: ListingRow[] = [];
    let remaining = skip;

    for (const city of ranked) {
      if (rows.length >= take) break;

      if (remaining >= city.count) {
        remaining -= city.count;
        continue;
      }

      const page = await this.database.professionalListing.findMany({
        where: { ...where, cityId: city.cityId },
        include: LISTING_INCLUDE,
        orderBy: LISTING_ORDER,
        skip: remaining,
        take: take - rows.length,
      });

      rows.push(...page);
      remaining = 0;
    }

    return rows;
  }

  private async hydrate(
    rows: ListingRow[],
    query: BrowseProfessionalsDto,
    origin: { latitude: number; longitude: number } | null,
    nearby: { anchorCityId: string; milesByCity: Map<string, number | null> } | null,
    total: number,
    inCityTotal: number,
  ) {
    const [professionLabels, summaries] = await Promise.all([
      this.taxonomy.labels(TaxonomyKind.PROFESSION),
      this.reputation.summariesFor(rows.map(row => row.userId)),
    ]);

    const mapped = await Promise.all(
      rows.map(async row => {
        const summary = summaries.get(row.userId)!;
        const categories = row.categories.map(category =>
          toTermView(category.code, professionLabels),
        );
        const isNearbyCity = nearby !== null && row.cityId !== nearby.anchorCityId;

        return {
          type: 'PROFESSIONAL' as const,
          id: row.id,
          user: toAuthorView(row.user, { sign: this.media.sign }),
          professionTitle: row.professionTitle,
          category: categories[0] ?? null,
          categories,
          city: toCityView(row.city),
          // Null unless nearMe was set with real coordinates (D25).
          distanceMiles: origin && row.city ? distanceMiles(origin, row.city) : null,
          // True when the searched city ran out and this one was pulled in to fill the page.
          isNearbyCity,
          milesFromSearchedCity: isNearbyCity
            ? (nearby.milesByCity.get(row.cityId ?? '') ?? null)
            : null,
          rating: {
            average: summary.average,
            count: summary.countedTotal,
            excludedCount: summary.excludedTotal,
          },
          medianResponseMinutes: row.medianResponseMinutes,
          priceFrom: money(row.priceFrom, row.currency),
          priceBasis: row.priceBasis,
          isAcceptingWork: row.isAcceptingWork,
          trustChecks: toAuthorView(row.user, { sign: this.media.sign }).trustChecks,
          isImmigrantFriendly: summary.isImmigrantFriendly,
          isRegulated: await this.listings.isRegulated(row.categories.map(c => c.code)),
          verificationStatus: row.verificationStatus,
        };
      }),
    );

    // After the distance is computed, which needs the city's coordinates.
    const filtered =
      origin && query.radiusMiles
        ? mapped.filter(
            item => item.distanceMiles !== null && item.distanceMiles <= query.radiusMiles!,
          )
        : mapped;

    return {
      rows: filtered,
      total: origin && query.radiusMiles ? filtered.length : total,
      inCityTotal,
    };
  }
  private async queryOffers(
    query: BrowseProfessionalsDto,
    viewerCityId: string | null,
    blockedIds: string[],
  ) {
    const where: Prisma.CommunityOfferWhereInput = {
      deletedAt: null,
      ...(blockedIds.length ? { authorId: { notIn: blockedIds } } : {}),
      // As in the community list: an offer promoted into a verified listing has become it.
      OR: [
        { promotedToListingId: null },
        {
          promotedToListing: { verificationStatus: { not: ListingVerificationStatus.VERIFIED } },
        },
      ],
    };

    const cityId = query.cityId ?? viewerCityId;

    if (cityId && cityId !== 'ANYWHERE') where.cityId = cityId;
    if (query.maxPrice !== undefined) where.priceFrom = { lte: query.maxPrice };
    if (query.q)
      where.title = { contains: escapeLike(query.q), mode: Prisma.QueryMode.insensitive };

    const window: { skip: number; take: number } =
      query.listingType === 'BOTH'
        ? { skip: 0, take: 100 }
        : { skip: query.skip, take: query.take };

    const [total, rows] = await this.database.$transaction([
      this.database.communityOffer.count({ where }),
      this.database.communityOffer.findMany({
        where,
        include: {
          author: { select: authorSelect },
          city: { select: { id: true, name: true, region: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: window.skip,
        take: window.take,
      }),
    ]);

    const [categoryLabels, summaries] = await Promise.all([
      this.taxonomy.labels(TaxonomyKind.COMMUNITY_CATEGORY),
      this.reputation.summariesFor(rows.map(row => row.authorId)),
    ]);

    return {
      rows: rows.map(row => {
        const summary = summaries.get(row.authorId)!;

        return {
          type: 'COMMUNITY_OFFER' as const,
          id: row.id,
          user: toAuthorView(row.author, { sign: this.media.sign }),
          professionTitle: row.title,
          category: toTermView(row.categoryCode, categoryLabels),
          categories: [toTermView(row.categoryCode, categoryLabels)].filter(Boolean),
          city: toCityView(row.city),
          distanceMiles: null,
          rating: {
            average: summary.average,
            count: summary.countedTotal,
            excludedCount: summary.excludedTotal,
          },
          medianResponseMinutes: null,
          priceFrom: money(row.priceFrom, row.currency),
          priceBasis: row.priceBasis,
          isAcceptingWork: true,
          trustChecks: toAuthorView(row.author, { sign: this.media.sign }).trustChecks,
          isImmigrantFriendly: summary.isImmigrantFriendly,
          isRegulated: false,
          verificationStatus: null,
        };
      }),
      total,
    };
  }

  private applySort<
    T extends {
      rating: { average: number; count: number };
      distanceMiles: number | null;
      isNearbyCity?: boolean;
      priceFrom: { amount: number } | null;
      medianResponseMinutes: number | null;
    },
  >(items: T[], sort: BrowseProfessionalsDto['sort']): T[] {
    const byNullsLast = (a: number | null, b: number | null) =>
      a === null ? 1 : b === null ? -1 : a - b;

    // The searched city first, whatever the sort: a five-star professional a county away is still
    // the wrong answer above a good one down the road.
    const byCityFirst = (rows: T[]) =>
      [...rows].sort((a, b) => Number(a.isNearbyCity ?? false) - Number(b.isNearbyCity ?? false));

    switch (sort) {
      case 'RATING':
        return byCityFirst([...items].sort((a, b) => b.rating.average - a.rating.average));
      case 'REVIEWS':
        return byCityFirst([...items].sort((a, b) => b.rating.count - a.rating.count));
      case 'NEAREST':
        return byCityFirst(
          [...items].sort((a, b) => byNullsLast(a.distanceMiles, b.distanceMiles)),
        );
      case 'PRICE':
        return byCityFirst(
          [...items].sort((a, b) =>
            byNullsLast(a.priceFrom?.amount ?? null, b.priceFrom?.amount ?? null),
          ),
        );
      case 'RESPONSE':
        return byCityFirst(
          [...items].sort((a, b) => byNullsLast(a.medianResponseMinutes, b.medianResponseMinutes)),
        );
      default:
        // RECOMMENDED: rated highly, by enough people to mean it.
        return byCityFirst(
          [...items].sort(
            (a, b) =>
              b.rating.average * Math.min(1, Math.log1p(b.rating.count) / Math.log(10)) -
              a.rating.average * Math.min(1, Math.log1p(a.rating.count) / Math.log(10)),
          ),
        );
    }
  }

  /** Where the member could widen to, with real counts rather than a guess. */
  private async nearbyCityMatches(query: BrowseProfessionalsDto, viewerCityId: string | null) {
    const cityId = query.cityId ?? viewerCityId;

    if (!cityId) return [];

    const category = query.category && !isAllCategories(query.category) ? query.category : null;

    const grouped = await this.database.professionalListing.groupBy({
      by: ['cityId'],
      where: {
        deletedAt: null,
        cityId: { not: cityId },
        verificationStatus: { not: ListingVerificationStatus.DRAFT },
        ...(category ? { categories: { some: { code: category } } } : {}),
      },
      _count: { _all: true },
      orderBy: { _count: { cityId: 'desc' } },
      take: 3,
    });

    if (!grouped.length) return [];

    const cities = await this.database.city.findMany({
      where: { id: { in: grouped.map(row => row.cityId) } },
      select: { id: true, name: true },
    });
    const names = new Map(cities.map(city => [city.id, city.name] as const));

    return grouped.map(row => ({
      cityId: row.cityId,
      name: names.get(row.cityId) ?? row.cityId,
      count: row._count._all,
    }));
  }

  // ─── 2.4 Profile ───────────────────────────────────────────────────────────

  /** Accepts either a listing id or the professional's USER id (D9). */
  async profile(viewerId: string, idOrUserId: string) {
    const listing = await this.database.professionalListing.findFirst({
      where: {
        OR: [{ id: idOrUserId }, { userId: idOrUserId }],
        deletedAt: null,
      },
      include: {
        user: { select: authorSelect },
        city: { select: { id: true, name: true, region: true } },
        categories: true,
        services: { orderBy: { sort: 'asc' } },
      },
    });

    if (!listing)
      throw ApiException.notFound(
        'That professional could not be found.',
        ApiErrorCode.LISTING_NOT_FOUND,
      );

    const isOwner = listing.userId === viewerId;

    if (!isOwner) {
      await this.database.professionalListing.update({
        where: { id: listing.id },
        data: { profileViews: { increment: 1 } },
      });
    }

    const [professionLabels, summary, trust, booking, conversation] = await Promise.all([
      this.taxonomy.labels(TaxonomyKind.PROFESSION),
      this.reputation.summaryFor(listing.userId),
      this.trustBlock(listing.userId),
      this.database.booking.findFirst({
        where: { clientId: viewerId, professionalId: listing.userId },
        select: { id: true },
      }),
      this.database.conversation.findFirst({
        where: {
          contextType: ThreadContextType.PROFESSIONAL,
          contextId: listing.id,
          participants: { some: { userId: viewerId } },
        },
        select: { id: true },
      }),
    ]);

    const categories = listing.categories.map(category =>
      toTermView(category.code, professionLabels),
    );

    return {
      id: listing.id,
      user: toAuthorView(listing.user, { sign: this.media.sign }),
      professionTitle: listing.professionTitle,
      categories,
      category: categories[0] ?? null,
      experienceLevel: listing.experienceLevel,
      yearsExperience: listing.yearsExperience,
      about: listing.about,
      city: toCityView(listing.city),
      deliveryMode: listing.deliveryMode,
      rating: this.reputation.toRatingView(summary),
      isImmigrantFriendly: summary.isImmigrantFriendly,
      stats: {
        jobsCompleted: listing.jobsCompleted,
        // One definition, three surfaces: the profile, the dashboard, and the maxResponseHours filter all read this number (2.11).
        medianResponseMinutes: listing.medianResponseMinutes,
        profileViews: listing.profileViews,
      },
      priceFrom: money(listing.priceFrom, listing.currency),
      priceBasis: listing.priceBasis,
      isAcceptingWork: listing.isAcceptingWork,
      freeConsultation: listing.freeConsultation,
      services: listing.services.map(service => ({
        id: service.id,
        name: service.name,
        description: service.description,
        price: money(service.price, service.currency),
        priceBasis: service.priceBasis,
        isActive: service.isActive,
      })),
      trust,
      isRegulated: await this.listings.isRegulated(listing.categories.map(c => c.code)),
      communityProfileUrl: `/profile/community/${listing.userId}`,
      verificationStatus: listing.verificationStatus,
      viewer: {
        isOwner,
        hasBookedBefore: booking !== null,
        // The exact condition the "I've worked with them before" entry point uses.
        canLeavePriorWorkReview: !isOwner && booking === null,
        conversationId: conversation?.id ?? null,
      },
    };
  }

  private async trustBlock(userId: string) {
    const rows = await this.database.trustCheck.findMany({
      where: { userId, status: 'VERIFIED' },
      orderBy: { verifiedAt: 'asc' },
    });

    return {
      checks: rows.map(row => ({
        check: row.check,
        verifiedAt: row.verifiedAt?.toISOString() ?? null,
        // A trust chip with no provenance is decoration (2.4).
        checkedBy: row.checkedBy ?? 'Circl',
        ...(row.reference ? { reference: row.reference } : {}),
        ...(row.expiresAt ? { expiresAt: row.expiresAt.toISOString() } : {}),
      })),
    };
  }

  private async viewerCityId(viewerId: string): Promise<string | null> {
    const profile = await this.database.userProfile.findUnique({
      where: { userId: viewerId },
      select: { cityId: true },
    });

    return profile?.cityId ?? null;
  }
}
