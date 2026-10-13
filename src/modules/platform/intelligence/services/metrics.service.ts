import { Injectable } from '@nestjs/common';
import {
  ActivitySubject,
  JobState,
  RequestStatus,
  SearchScope,
  SearchTermSource,
  TaxonomyKind,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { daysAgo, toJson } from '@/common';
import { PUBLIC_VISIBILITY, TaxonomyService } from '../../shared';

export type MetricSection = 'COMMUNITY' | 'PROFESSIONALS' | 'CONNECT' | 'COMMERCE';
export type MetricPeriod = 'WEEK' | 'MONTH' | 'ALL_TIME';

/** D19, applied to every section rather than only Connect. */
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

/** Circl Intelligence: Public Metrics. */
/**
 * ## Why nothing in this file filters on a suspended author (§13.2)
 *
 * Every other distribution read on the platform hides a suspended member's content, because those
 * reads answer "what can somebody find right now". Pulse answers a different question: **what
 * happened in this city**. A request somebody asked in March was asked in March, and a suspension
 * in October does not change that — filtering it out would rewrite the past.
 *
 * It would also make the numbers useless in a specific way: they would move whenever a suspension
 * started or ended, so week-on-week comparisons would measure moderation activity rather than
 * community activity, and nobody reading the chart would know which.
 *
 * §13.2 draws the line in the same place: a suspended member is "counted as members, excluded from
 * *active* metrics". Counted — which is what this file does.
 *
 * `DemandService` is the deliberate exception next door, because supply is not a historical count:
 * it is what a member searching would find today, so a suspended seller's item is not supply.
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
      // Stated rather than hidden, so a reader knows an empty list means "too few to publish" and not "nothing happened".
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
    const cities = await this.database.city.findMany({
      where: { isActive: true },
      select: { id: true },
    });

    let written = 0;

    // The national view first, then per city.
    for (const cityId of [null, ...cities.map(city => city.id)]) {
      written += await this.rebuildCommunity(cityId, period, since);
      written += await this.rebuildProfessionals(cityId, period, since);
      written += await this.rebuildCommerce(cityId, period, since);
      written += await this.rebuildConnect(cityId, period, since);
    }

    return written;
  }

  // Every rollup below filters `PUBLIC_VISIBILITY` (§6.5). Pulse is published to members — "the
  // top five things Manchester is asking about" — so a held post must not be able to become a
  // headline, and a count that includes one is a count of something nobody can open.

  // ─── Community ─────────────────────────────────────────────────────────────

  private async rebuildCommunity(cityId: string | null, period: MetricPeriod, since: Date) {
    const scope = cityId ? { cityId } : {};
    const labels = await this.taxonomy.labels(TaxonomyKind.COMMUNITY_CATEGORY);

    const [topAsks, unanswered, guides, groups] = await Promise.all([
      // author-status: Pulse counts what happened, not what is findable — see the class note.
      this.database.communityRequest.groupBy({
        by: ['categoryCode'],
        where: { deletedAt: null, ...PUBLIC_VISIBILITY, createdAt: { gte: since }, ...scope },
        _count: { _all: true },
        orderBy: { _count: { categoryCode: 'desc' } },
        take: 10,
      }),
      // "Questions we still cannot answer" — the metric the resolve outcome feeds.
      // author-status: Pulse counts what happened, not what is findable — see the class note.
      this.database.communityRequest.groupBy({
        by: ['categoryCode'],
        where: {
          deletedAt: null,
          ...PUBLIC_VISIBILITY,
          createdAt: { gte: since },
          status: RequestStatus.OPEN,
          replyCount: 0,
          ...scope,
        },
        _count: { _all: true },
        orderBy: { _count: { categoryCode: 'desc' } },
        take: 10,
      }),
      // author-status: Pulse counts what happened, not what is findable — see the class note.
      this.database.guide.findMany({
        where: {
          deletedAt: null,
          ...PUBLIC_VISIBILITY,
          publishedAt: { not: null },
          ...(cityId ? { cityId } : {}),
        },
        orderBy: { viewCount: 'desc' },
        select: { id: true, title: true, viewCount: true, likeCount: true },
        take: 10,
      }),
      this.database.group.findMany({
        where: { deletedAt: null, ...PUBLIC_VISIBILITY, ...scope },
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
        where: { listing: { deletedAt: null, ...PUBLIC_VISIBILITY, ...scope } },
        _count: { _all: true },
        orderBy: { _count: { code: 'desc' } },
        take: 10,
      }),
      // author-status: Pulse counts what happened, not what is findable — see the class note.
      this.database.professionalListing.groupBy({
        by: ['priceBasis'],
        where: { deletedAt: null, ...PUBLIC_VISIBILITY, priceFrom: { not: null }, ...scope },
        _avg: { priceFrom: true },
        _count: { _all: true },
      }),
      this.database.booking.count({
        where: { state: JobState.COMPLETED, completedAt: { gte: since } },
      }),
      // author-status: Pulse counts what happened, not what is findable — see the class note.
      this.database.professionalListing.aggregate({
        where: {
          deletedAt: null,
          ...PUBLIC_VISIBILITY,
          medianResponseMinutes: { not: null },
          ...scope,
        },
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
          ? [
              {
                label: 'Median response',
                value: Math.round(response._avg.medianResponseMinutes ?? 0),
              },
            ]
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
          // "What people searched for" on the COMMERCE dashboard means the shop's search box, not
          // every box on the platform. Scoped by verb alone this printed "bank account" and
          // "immigration" as things people were shopping for. The second arm is the older rows,
          // which carry the subject and no scope.
          OR: [{ scope: SearchScope.PRODUCTS }, { subject: ActivitySubject.STORE_ITEM }],
          term: { not: null },
          occurredAt: { gte: since },
          ...(cityId ? { cityId } : {}),
        },
        _count: { _all: true },
        orderBy: { _count: { term: 'desc' } },
        take: 10,
      }),
      // author-status: Pulse counts what happened, not what is findable — see the class note.
      this.database.storeItem.groupBy({
        by: ['categoryCode'],
        where: { deletedAt: null, ...PUBLIC_VISIBILITY, ...storeScope },
        _avg: { price: true },
        _count: { _all: true },
        orderBy: { _count: { categoryCode: 'desc' } },
        take: 10,
      }),
      this.database.storeCategory.groupBy({
        by: ['code'],
        where: { store: { deletedAt: null, ...PUBLIC_VISIBILITY, ...(cityId ? { cityId } : {}) } },
        _count: { _all: true },
        orderBy: { _count: { code: 'desc' } },
        take: 10,
      }),
    ]);

    // The lines carry the name that was copied at send time, not the category. Without it the
    // action row's route came out as `/commerce?category=` — a filter with nothing in it — and the
    // client had no code to narrow the list with either.
    // author-status: Pulse counts what happened, not what is findable — see the class note.
    const categoryOf = new Map(
      (
        await this.database.storeItem.findMany({
          where: { name: { in: topItems.map(row => row.name) }, ...PUBLIC_VISIBILITY },
          select: { name: true, categoryCode: true },
        })
      ).map(item => [item.name, item.categoryCode]),
    );

    return this.write('COMMERCE', cityId, period, since, {
      topProducts: this.floorBy(
        topItems.map(row => ({
          label: row.name,
          code: categoryOf.get(row.name),
          value: row._sum.quantity ?? 0,
        })),
        CONTENT_FLOOR,
      ),
      mostSearched: this.floorBy(await this.namedSearches(searches), CONTENT_FLOOR),
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

  /** The only section whose every metric counts PEOPLE, so every bucket takes the full floor. */
  private async rebuildConnect(cityId: string | null, period: MetricPeriod, since: Date) {
    const scope = cityId
      ? {
          OR: [{ cityIdOverride: cityId }, { cityIdOverride: null, user: { profile: { cityId } } }],
        }
      : {};

    const [types, heritage] = await Promise.all([
      // author-status: Pulse counts what happened, not what is findable — see the class note.
      this.database.connectProfile.groupBy({
        by: ['typeCode'],
        where: { deletedAt: null, ...PUBLIC_VISIBILITY, isVisible: true, ...scope },
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

  /** How many distinct people are behind a section's numbers in a city (6.2.1). */
  private async contributingMembers(
    section: MetricSection,
    cityId: string | null,
    since: Date,
  ): Promise<number> {
    const scope = cityId ? { cityId } : {};

    const distinct = (rows: Array<{ authorId?: string; userId?: string; ownerId?: string }>) =>
      new Set(rows.map(row => row.authorId ?? row.userId ?? row.ownerId).filter(Boolean)).size;

    switch (section) {
      case 'COMMUNITY': {
        const [requests, offers, updates] = await Promise.all([
          // author-status: Pulse counts what happened, not what is findable — see the class note.
          this.database.communityRequest.findMany({
            where: { deletedAt: null, ...PUBLIC_VISIBILITY, createdAt: { gte: since }, ...scope },
            select: { authorId: true },
            distinct: ['authorId'],
          }),
          // author-status: Pulse counts what happened, not what is findable — see the class note.
          this.database.communityOffer.findMany({
            where: { deletedAt: null, ...PUBLIC_VISIBILITY, createdAt: { gte: since }, ...scope },
            select: { authorId: true },
            distinct: ['authorId'],
          }),
          // author-status: Pulse counts what happened, not what is findable — see the class note.
          this.database.communityUpdate.findMany({
            where: { deletedAt: null, ...PUBLIC_VISIBILITY, createdAt: { gte: since }, ...scope },
            select: { authorId: true },
            distinct: ['authorId'],
          }),
        ]);

        return distinct([...requests, ...offers, ...updates]);
      }

      case 'PROFESSIONALS': {
        // author-status: Pulse counts what happened, not what is findable — see the class note.
        const listings = await this.database.professionalListing.findMany({
          where: { deletedAt: null, ...PUBLIC_VISIBILITY, ...scope },
          select: { userId: true },
          distinct: ['userId'],
        });

        return distinct(listings);
      }

      case 'COMMERCE': {
        // author-status: Pulse counts what happened, not what is findable — see the class note.
        const stores = await this.database.store.findMany({
          where: { deletedAt: null, ...PUBLIC_VISIBILITY, ...scope },
          select: { ownerId: true },
          distinct: ['ownerId'],
        });

        return distinct(stores);
      }

      case 'CONNECT': {
        // Connect scopes by `cityIdOverride` falling back to the member's own city, not by a `cityId` of its own: the override is where somebody is looking, which is deliberately not where they are (3.1).
        // author-status: Pulse counts what happened, not what is findable — see the class note.
        const profiles = await this.database.connectProfile.findMany({
          where: {
            deletedAt: null,
            ...PUBLIC_VISIBILITY,
            ...(cityId
              ? {
                  OR: [
                    { cityIdOverride: cityId },
                    { cityIdOverride: null, user: { profile: { cityId } } },
                  ],
                }
              : {}),
          },
          select: { userId: true },
          distinct: ['userId'],
        });

        return distinct(profiles);
      }
    }
  }

  /**
   * Search terms under the name of the thing people were reaching for.
   *
   * The raw column holds what was typed, so this bar read "ko" and "ol" — the fragments that
   * started the whole resolution problem, printed on a dashboard where nobody can tell what they
   * mean. The dictionary already knows: "ko" is Kohl liner. Terms that fold onto the same answer
   * are added together, as the published lists add them, and a fragment that resolved to nothing
   * is dropped rather than shown as itself.
   */
  private async namedSearches(
    rows: Array<{ term: string | null; _count: { _all: number } }>,
  ): Promise<MetricItem[]> {
    const normalise = (term: string) =>
      term
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, '')
        .trim();

    const known = await this.database.searchTermCanonical.findMany({
      where: {
        scope: SearchScope.PRODUCTS,
        normalised: { in: rows.flatMap(row => (row.term ? [normalise(row.term)] : [])) },
      },
      select: { normalised: true, canonical: true, categoryCode: true, source: true },
    });
    const dictionary = new Map(known.map(row => [row.normalised, row]));
    const folded = new Map<string, MetricItem>();

    for (const row of rows) {
      if (!row.term) continue;

      const entry = dictionary.get(normalise(row.term));

      if (entry?.source === SearchTermSource.JUNK) continue;

      // Unresolved is not the same as junk: the dictionary is only built for the scopes the
      // published lists record, and an older row may predate it. Those keep the typed form.
      const label = entry?.canonical ?? row.term;
      const seen = folded.get(label.toLowerCase());

      if (seen) {
        seen.value += row._count._all;
        continue;
      }

      folded.set(label.toLowerCase(), {
        term: row.term,
        label,
        code: entry?.categoryCode ?? undefined,
        value: row._count._all,
      });
    }

    return [...folded.values()].sort((a, b) => b.value - a.value);
  }

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

    // Written alongside the metrics rather than computed on read: Pulse is a dashboard, and a distinct count over three tables on every mount is the kind of query that is fine until it is not.
    const withGate: Record<string, MetricItem[]> = {
      ...metrics,
      contributingMembers: [
        {
          label: 'Contributing members',
          value: await this.contributingMembers(section, cityId, windowStart),
        },
      ],
    };

    for (const [metric, items] of Object.entries(withGate)) {
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
