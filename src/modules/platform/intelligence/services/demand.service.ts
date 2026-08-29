import { Injectable } from '@nestjs/common';
import { ActivityVerb, Prisma, SuggestionSurface, TaxonomyKind } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { daysAgo } from '@/common';
import { TaxonomyService } from '../../shared';

export interface Suggestion {
  code: string | null;
  term: string | null;
  label: string;
  /** Plain enough that a member can judge whether to believe it. */
  reason: string;
  searches: number;
  supply: number;
}

/** Below this, a "signal" is noise wearing a suit. */
const MIN_DEMAND = 3;

/** How far back demand is measured. */
const WINDOW_DAYS = 30;

/** Circl Intelligence: Guided Creation and the demand rollup. */
@Injectable()
export class DemandService {
  constructor(
    private readonly database: PrismaService,
    private readonly taxonomy: TaxonomyService,
  ) {}

  /** What is in demand near this member, on this surface, that they are not already offering. */
  async suggestionsFor(options: {
    surface: SuggestionSurface;
    cityId: string | null;
    /** Codes the member already covers, which are never suggested back to them. */
    excludeCodes?: string[];
    limit?: number;
  }): Promise<Suggestion[]> {
    const rows = await this.database.demandSignal.findMany({
      where: {
        surface: options.surface,
        ...(options.cityId ? { cityId: options.cityId } : {}),
        score: { gt: 0 },
        ...(options.excludeCodes?.length ? { code: { notIn: options.excludeCodes } } : {}),
      },
      orderBy: { score: 'desc' },
      take: options.limit ?? 3,
    });

    const cityName = options.cityId
      ? (
          await this.database.city.findUnique({
            where: { id: options.cityId },
            select: { name: true },
          })
        )?.name
      : null;

    return rows
      .filter(row => row.searchCount + row.actionCount >= MIN_DEMAND)
      .map(row => ({
        code: row.code,
        term: row.term,
        label: row.label,
        reason: this.reasonFor(row.surface, row.searchCount + row.actionCount, cityName),
        searches: row.searchCount,
        supply: row.supplyCount,
      }));
  }

  /** A sentence a member can check, not a tone. */
  private reasonFor(surface: SuggestionSurface, count: number, cityName: string | null): string {
    const where = cityName ? ` in ${cityName}` : ' near you';

    switch (surface) {
      case SuggestionSurface.STORE_ITEM:
        return `${count} buyers${where} searched for this in the last month.`;
      case SuggestionSurface.PROFESSIONAL_SERVICE:
        return `${count} people${where} looked for this in the last month.`;
      default:
        return `${count} people${where} asked about this in the last month.`;
    }
  }

  /** Rebuilds the rollup from the event stream. */
  async rebuild(): Promise<number> {
    const windowStart = daysAgo(WINDOW_DAYS);
    const windowEnd = new Date();

    const [categoryLabels, professionLabels, itemLabels] = await Promise.all([
      this.taxonomy.labels(TaxonomyKind.COMMUNITY_CATEGORY),
      this.taxonomy.labels(TaxonomyKind.PROFESSION),
      this.taxonomy.labels(TaxonomyKind.ITEM_CATEGORY),
    ]);

    let written = 0;

    // ── Demand by code, per city ──────────────────────────────────────────────
    const byCode = await this.database.activityEvent.groupBy({
      by: ['cityId', 'subject', 'code'],
      where: { occurredAt: { gte: windowStart }, code: { not: null } },
      _sum: { weight: true },
      _count: { _all: true },
    });

    for (const row of byCode) {
      const surface = this.surfaceFor(row.subject);

      if (!surface) continue;

      const labels =
        surface === SuggestionSurface.STORE_ITEM
          ? itemLabels
          : surface === SuggestionSurface.PROFESSIONAL_SERVICE
            ? professionLabels
            : categoryLabels;

      const supplyCount = await this.supplyFor(surface, row.cityId, row.code!);

      await this.database.demandSignal.upsert({
        where: {
          cityId_surface_code_term: {
            cityId: row.cityId ?? '',
            surface,
            code: row.code!,
            term: '',
          },
        },
        update: {
          label: labels.get(row.code!) ?? row.code!,
          actionCount: row._count._all,
          supplyCount,
          // Demand relative to supply.
          score: this.score(row._sum.weight ?? 0, supplyCount),
          windowStart,
          windowEnd,
          computedAt: new Date(),
        },
        create: {
          cityId: row.cityId ?? '',
          surface,
          code: row.code!,
          term: '',
          label: labels.get(row.code!) ?? row.code!,
          searchCount: 0,
          actionCount: row._count._all,
          supplyCount,
          score: this.score(row._sum.weight ?? 0, supplyCount),
          windowStart,
          windowEnd,
        },
      });

      written += 1;
    }

    // ── Demand by search term, per city ───────────────────────────────────────
    const byTerm = await this.database.activityEvent.groupBy({
      by: ['cityId', 'term'],
      where: {
        occurredAt: { gte: windowStart },
        verb: ActivityVerb.SEARCH,
        term: { not: null },
      },
      _count: { _all: true },
    });

    for (const row of byTerm) {
      if (row._count._all < MIN_DEMAND) continue;

      const supplyCount = await this.database.storeItem.count({
        where: {
          deletedAt: null,
          name: { contains: row.term!, mode: Prisma.QueryMode.insensitive },
          ...(row.cityId ? { store: { cityId: row.cityId } } : {}),
        },
      });

      await this.database.demandSignal.upsert({
        where: {
          cityId_surface_code_term: {
            cityId: row.cityId ?? '',
            surface: SuggestionSurface.STORE_ITEM,
            code: '',
            term: row.term!,
          },
        },
        update: {
          label: row.term!,
          searchCount: row._count._all,
          supplyCount,
          score: this.score(row._count._all, supplyCount),
          windowStart,
          windowEnd,
          computedAt: new Date(),
        },
        create: {
          cityId: row.cityId ?? '',
          surface: SuggestionSurface.STORE_ITEM,
          code: '',
          term: row.term!,
          label: row.term!,
          searchCount: row._count._all,
          actionCount: 0,
          supplyCount,
          score: this.score(row._count._all, supplyCount),
          windowStart,
          windowEnd,
        },
      });

      written += 1;
    }

    // Anything not refreshed this run has fallen out of the window.
    await this.database.demandSignal.deleteMany({
      where: { computedAt: { lt: daysAgo(WINDOW_DAYS * 2) } },
    });

    return written;
  }

  /** Demand over supply, damped so one supplier does not zero a real gap. */
  private score(demand: number, supply: number): number {
    return Number((demand / (1 + supply)).toFixed(4));
  }

  private surfaceFor(subject: string): SuggestionSurface | null {
    switch (subject) {
      case 'REQUEST':
        return SuggestionSurface.COMMUNITY_OFFER;
      case 'OFFER':
        return SuggestionSurface.COMMUNITY_REQUEST;
      case 'PROFESSIONAL_LISTING':
        return SuggestionSurface.PROFESSIONAL_SERVICE;
      case 'STORE_ITEM':
      case 'STORE':
        return SuggestionSurface.STORE_ITEM;
      default:
        return null;
    }
  }

  private async supplyFor(
    surface: SuggestionSurface,
    cityId: string | null,
    code: string,
  ): Promise<number> {
    switch (surface) {
      case SuggestionSurface.COMMUNITY_OFFER:
        return this.database.communityOffer.count({
          where: { deletedAt: null, categoryCode: code, ...(cityId ? { cityId } : {}) },
        });
      case SuggestionSurface.PROFESSIONAL_SERVICE:
        return this.database.professionalListing.count({
          where: {
            deletedAt: null,
            categories: { some: { code } },
            ...(cityId ? { cityId } : {}),
          },
        });
      case SuggestionSurface.STORE_ITEM:
        return this.database.storeItem.count({
          where: { deletedAt: null, categoryCode: code, ...(cityId ? { store: { cityId } } : {}) },
        });
      default:
        return this.database.communityRequest.count({
          where: { deletedAt: null, categoryCode: code, ...(cityId ? { cityId } : {}) },
        });
    }
  }
}
