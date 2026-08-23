import { Injectable } from '@nestjs/common';
import { JobState, RequestStatus, TaxonomyKind } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { daysAgo, toJson } from '@/common';
import { TaxonomyService } from '../../shared';

export type MetricSection = 'COMMUNITY' | 'PROFESSIONALS' | 'CONNECT' | 'COMMERCE';
export type MetricPeriod = 'WEEK' | 'MONTH' | 'ALL_TIME';

/**
 * D19, applied to every section rather than only Connect.
 *
 * "Any bucket under 20 people is suppressed rather than rounded, and no view
 * exposes an individual." A city with four Eritrean members and one dashboard
 * saying so has identified those four people to anyone who knows the city.
 *
 * The spec flags this as worth a second look with counsel before Pulse ships,
 * and that note belongs here, next to the number that enforces it: small buckets
 * in a small city are re-identifiable even in aggregate.
 */
const SUPPRESSION_FLOOR = 20;

/** Buckets that count things rather than people can be smaller and still safe. */
const CONTENT_FLOOR = 3;

export interface MetricItem {
  code?: string;
  term?: string;
  label: string;
  value: number;
  [key: string]: unknown;
}

/**
 * Circl Intelligence: Public Metrics.
 *
 * "The same behavioural data is surfaced as top items, top professionals, top
 * businesses, average prices, demand trends, and most-searched keywords — one
 * engine, four views."
 *
 * Precomputed on a schedule and read from a snapshot, because a dashboard that
 * aggregates the event stream on every load is a dashboard that times out.
 */
@Injectable()
export class MetricsService {
  constructor(
    private readonly database: PrismaService,
    private readonly taxonomy: TaxonomyService,
  ) {}

  /** Reads a section's dashboard. Returns whatever survived suppression. */
  async dashboard(section: MetricSection, cityId: string | null, period: MetricPeriod = 'MONTH') {
    const snapshots = await this.database.metricSnapshot.findMany({
      where: { section, cityId: cityId ?? null, period },
    });

    return {
      section,
      cityId,
      period,
      computedAt: snapshots[0]?.computedAt.toISOString() ?? null,
      metrics: Object.fromEntries(snapshots.map(row => [row.metric, row.items])),
      // Stated rather than hidden, so a reader knows an empty list means "too few
      // to publish" and not "nothing happened".
      suppression: {
        peopleFloor: SUPPRESSION_FLOOR,
        contentFloor: CONTENT_FLOOR,
        note: 'Buckets below these thresholds are suppressed rather than rounded, so no view can identify an individual.',
      },
    };
  }

  /** Recomputes every section for every city with enough activity to publish. */
  async rebuild(period: MetricPeriod = 'MONTH'): Promise<number> {
    const since = period === 'WEEK' ? daysAgo(7) : period === 'MONTH' ? daysAgo(30) : new Date(0);
    const cities = await this.database.city.findMany({ where: { isActive: true }, select: { id: true } });

    let written = 0;

    // The national view first, then per city. A city with too little activity
    // publishes nothing, which is the correct outcome rather than a failure.
    for (const cityId of [null, ...cities.map(city => city.id)]) {
      written += await this.rebuildCommunity(cityId, period, since);
      written += await this.rebuildProfessionals(cityId, period, since);
      written += await this.rebuildCommerce(cityId, period, since);
      written += await this.rebuildConnect(cityId, period, since);
    }

    return written;
  }

  // ─── Community ─────────────────────────────────────────────────────────────

  private async rebuildCommunity(cityId: string | null, period: MetricPeriod, since: Date) {
    const scope = cityId ? { cityId } : {};
    const labels = await this.taxonomy.labels(TaxonomyKind.COMMUNITY_CATEGORY);

    const [topAsks, unanswered, guides, groups] = await Promise.all([
      this.database.communityRequest.groupBy({
        by: ['categoryCode'],
        where: { deletedAt: null, createdAt: { gte: since }, ...scope },
        _count: { _all: true },
        orderBy: { _count: { categoryCode: 'desc' } },
        take: 10,
      }),
      // "Questions we still cannot answer" — the metric the resolve outcome feeds.
      this.database.communityRequest.groupBy({
        by: ['categoryCode'],
        where: {
          deletedAt: null,
          createdAt: { gte: since },
          status: RequestStatus.OPEN,
          replyCount: 0,
          ...scope,
        },
        _count: { _all: true },
        orderBy: { _count: { categoryCode: 'desc' } },
        take: 10,
      }),
      this.database.guide.findMany({
        where: { deletedAt: null, publishedAt: { not: null }, ...(cityId ? { cityId } : {}) },
        orderBy: { viewCount: 'desc' },
        select: { id: true, title: true, viewCount: true, likeCount: true },
        take: 10,
      }),
      this.database.group.findMany({
        where: { deletedAt: null, ...scope },
        orderBy: [{ memberCount: 'desc' }],
        select: { id: true, name: true, memberCount: true },
        take: 10,
      }),
    ]);

    return this.write('COMMUNITY', cityId, period, since, {
      topRequests: this.floorBy(
        topAsks.map(row => ({
          code: row.categoryCode,
          label: labels.get(row.categoryCode) ?? row.categoryCode,
          value: row._count._all,
        })),
        CONTENT_FLOOR,
      ),
      unansweredRequests: this.floorBy(
        unanswered.map(row => ({
          code: row.categoryCode,
          label: labels.get(row.categoryCode) ?? row.categoryCode,
          value: row._count._all,
        })),
        CONTENT_FLOOR,
      ),
      mostEngagedGuides: this.floorBy(
        guides.map(guide => ({
          code: guide.id,
          label: guide.title,
          value: guide.viewCount,
          likes: guide.likeCount,
        })),
        CONTENT_FLOOR,
      ),
      // Groups count PEOPLE, so they take the people floor.
      activeGroups: this.floorBy(
        groups.map(group => ({ code: group.id, label: group.name, value: group.memberCount })),
        SUPPRESSION_FLOOR,
      ),
    });
  }

  // ─── Professionals ─────────────────────────────────────────────────────────

  private async rebuildProfessionals(cityId: string | null, period: MetricPeriod, since: Date) {
    const scope = cityId ? { cityId } : {};
    const labels = await this.taxonomy.labels(TaxonomyKind.PROFESSION);

    const [inDemand, prices, jobs, response] = await Promise.all([
      this.database.professionalListingCategory.groupBy({
        by: ['code'],
        where: { listing: { deletedAt: null, ...scope } },
        _count: { _all: true },
        orderBy: { _count: { code: 'desc' } },
        take: 10,
      }),
      this.database.professionalListing.groupBy({
        by: ['priceBasis'],
        where: { deletedAt: null, priceFrom: { not: null }, ...scope },
        _avg: { priceFrom: true },
        _count: { _all: true },
      }),
      this.database.booking.count({
        where: { state: JobState.COMPLETED, completedAt: { gte: since } },
      }),
      this.database.professionalListing.aggregate({
        where: { deletedAt: null, medianResponseMinutes: { not: null }, ...scope },
        _avg: { medianResponseMinutes: true },
        _count: { _all: true },
      }),
    ]);

    return this.write('PROFESSIONALS', cityId, period, since, {
      servicesInDemand: this.floorBy(
        inDemand.map(row => ({
          code: row.code,
          label: labels.get(row.code) ?? row.code,
          value: row._count._all,
        })),
        CONTENT_FLOOR,
      ),
      averagePrices: this.floorBy(
        prices.map(row => ({
          code: row.priceBasis,
          label: row.priceBasis,
          // Pence, like every other amount in this API.
          value: Math.round(row._avg.priceFrom ?? 0),
          listings: row._count._all,
        })),
        CONTENT_FLOOR,
      ),
      jobsThisPeriod: [{ label: 'Jobs completed', value: jobs }],
      averageResponseMinutes:
        (response._count._all ?? 0) >= CONTENT_FLOOR
          ? [{ label: 'Median response', value: Math.round(response._avg.medianResponseMinutes ?? 0) }]
          : [],
    });
  }

  // ─── Commerce ──────────────────────────────────────────────────────────────

  private async rebuildCommerce(cityId: string | null, period: MetricPeriod, since: Date) {
    const storeScope = cityId ? { store: { cityId } } : {};
    const labels = await this.taxonomy.labels(TaxonomyKind.ITEM_CATEGORY);

    const [topItems, searches, prices, categories] = await Promise.all([
      this.database.enquiryLine.groupBy({
        by: ['name'],
        where: { enquiry: { createdAt: { gte: since }, ...(cityId ? { store: { cityId } } : {}) } },
        _sum: { quantity: true },
        orderBy: { _sum: { quantity: 'desc' } },
        take: 10,
      }),
      this.database.activityEvent.groupBy({
        by: ['term'],
        where: {
          verb: 'SEARCH',
          term: { not: null },
          occurredAt: { gte: since },
          ...(cityId ? { cityId } : {}),
        },
        _count: { _all: true },
        orderBy: { _count: { term: 'desc' } },
        take: 10,
      }),
      this.database.storeItem.groupBy({
        by: ['categoryCode'],
        where: { deletedAt: null, ...storeScope },
        _avg: { price: true },
        _count: { _all: true },
        orderBy: { _count: { categoryCode: 'desc' } },
        take: 10,
      }),
      this.database.storeCategory.groupBy({
        by: ['code'],
        where: { store: { deletedAt: null, ...(cityId ? { cityId } : {}) } },
        _count: { _all: true },
        orderBy: { _count: { code: 'desc' } },
        take: 10,
      }),
    ]);

    return this.write('COMMERCE', cityId, period, since, {
      topProducts: this.floorBy(
        topItems.map(row => ({ label: row.name, value: row._sum.quantity ?? 0 })),
        CONTENT_FLOOR,
      ),
      mostSearched: this.floorBy(
        searches.map(row => ({ term: row.term!, label: row.term!, value: row._count._all })),
        CONTENT_FLOOR,
      ),
      averagePrices: this.floorBy(
        prices.map(row => ({
          code: row.categoryCode,
          label: labels.get(row.categoryCode) ?? row.categoryCode,
          value: Math.round(row._avg.price ?? 0),
          items: row._count._all,
        })),
        CONTENT_FLOOR,
      ),
      storesByCategory: this.floorBy(
        categories.map(row => ({
          code: row.code,
          label: labels.get(row.code) ?? row.code,
          value: row._count._all,
        })),
        CONTENT_FLOOR,
      ),
    });
  }

  // ─── Connect ───────────────────────────────────────────────────────────────

  /**
   * The only section whose every metric counts PEOPLE, so every bucket takes the
   * full floor. This is the one D19 was written about.
   */
  private async rebuildConnect(cityId: string | null, period: MetricPeriod, since: Date) {
    const scope = cityId
      ? { OR: [{ cityIdOverride: cityId }, { cityIdOverride: null, user: { profile: { cityId } } }] }
      : {};

    const [types, heritage] = await Promise.all([
      this.database.connectProfile.groupBy({
        by: ['typeCode'],
        where: { deletedAt: null, isVisible: true, ...scope },
        _count: { _all: true },
        orderBy: { _count: { typeCode: 'desc' } },
      }),
      this.database.userProfile.groupBy({
        by: ['heritageTag'],
        where: {
          heritageTag: { not: null },
          user: { connectProfile: { isVisible: true, deletedAt: null } },
          ...(cityId ? { cityId } : {}),
        },
        _count: { _all: true },
      }),
    ]);

    const typeLabels = await this.taxonomy.labels(TaxonomyKind.CONNECTION_TYPE);
    const heritageLabels = await this.taxonomy.labels(TaxonomyKind.HERITAGE_TAG);

    return this.write('CONNECT', cityId, period, since, {
      trendingTypes: this.floorBy(
        types.map(row => ({
          code: row.typeCode,
          label: typeLabels.get(row.typeCode) ?? row.typeCode,
          value: row._count._all,
        })),
        SUPPRESSION_FLOOR,
      ),
      // Suppressed hard: heritage plus a small city is re-identifiable.
      demandByBackground: this.floorBy(
        heritage.map(row => ({
          code: row.heritageTag!,
          label: heritageLabels.get(row.heritageTag!) ?? row.heritageTag!,
          value: row._count._all,
        })),
        SUPPRESSION_FLOOR,
      ),
    });
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /** Suppressed, never rounded: rounding 4 to "fewer than 10" still says 4 exist. */
  private floorBy(items: MetricItem[], floor: number): MetricItem[] {
    return items.filter(item => item.value >= floor);
  }

  private async write(
    section: MetricSection,
    cityId: string | null,
    period: MetricPeriod,
    windowStart: Date,
    metrics: Record<string, MetricItem[]>,
  ): Promise<number> {
    const windowEnd = new Date();
    let written = 0;

    for (const [metric, items] of Object.entries(metrics)) {
      await this.database.metricSnapshot.upsert({
        where: {
          section_metric_cityId_period: { section, metric, cityId: cityId ?? '', period },
        },
        update: { items: toJson(items), windowStart, windowEnd, computedAt: windowEnd },
        create: {
          section,
          metric,
          cityId: cityId ?? '',
          period,
          items: toJson(items),
          windowStart,
          windowEnd,
        },
      });

      written += 1;
    }

    return written;
  }
}
