import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ApiErrorCode, ApiException } from '@/common';
import { AnalyticsRunnerService } from '../analytics/analytics-runner.service';
import { AnalyticsResponse, Chart } from '../analytics/chart.types';
import { DemographicsAnalytics } from '../analytics/demographics.analytics';
import { CommerceAnalytics } from '../analytics/commerce.analytics';
import { CommunityAnalytics } from '../analytics/community.analytics';
import { ConnectAnalytics } from '../analytics/connect.analytics';
import { DealsAnalytics } from '../analytics/deals.analytics';
import { ProfessionalsAnalytics } from '../analytics/professionals.analytics';
import { SafetyAnalytics } from '../analytics/safety.analytics';
import { SearchAnalytics } from '../analytics/search.analytics';
import { SupportAnalytics } from '../analytics/support.analytics';
import { GrowthAnalytics } from '../analytics/growth.analytics';
import { OverviewAnalytics } from '../analytics/overview.analytics';
import { suppressEverything } from '../analytics/suppression';
import { AdminPrincipal } from '../common/admin-principal';
import { AnalyticsFilterDto } from '../dtos/analytics-filter.dto';
import {
  AnalyticsTab,
  CommerceFilters,
  CommunityFilters,
  ConnectFilters,
  DealFilters,
  PopulationMode,
  ProfessionalFilters,
  SafetyFilters,
  SearchFilters,
  SupportFilters,
  TAB_PERMISSIONS,
} from '../dtos/admin-analytics.dto';
import { MemberFilterBuilder } from '../filters/member-filter.builder';

/** Below this the whole response is withheld, not just its member counts (§2.7 population floor). */
const POPULATION_FLOOR = 10;

/**
 * One endpoint per analytics tab (§5.25).
 *
 * The tab decides which charts exist; the runner decides what is computed, cached and suppressed.
 * This service is the part in between: it checks the tab's permission, resolves the filter once,
 * applies the population floor, and narrows to `charts=` when the portal asks for one chart back.
 */
@Injectable()
export class AdminAnalyticsService {
  /** Tabs whose charts are built. The rest answer 400 until they are. */
  private readonly built = new Set<AnalyticsTab>([
    'overview',
    'growth',
    'demographics',
    'community',
    'professionals',
    'connect',
    'commerce',
    'deals',
    'search',
    'trust-safety',
    'support',
  ]);

  constructor(
    private readonly filters: MemberFilterBuilder,
    private readonly runner: AnalyticsRunnerService,
    private readonly overview: OverviewAnalytics,
    private readonly demographics: DemographicsAnalytics,
    private readonly growth: GrowthAnalytics,
    private readonly community: CommunityAnalytics,
    private readonly deals: DealsAnalytics,
    private readonly connect: ConnectAnalytics,
    private readonly commerce: CommerceAnalytics,
    private readonly professionals: ProfessionalsAnalytics,
    private readonly search: SearchAnalytics,
    private readonly safety: SafetyAnalytics,
    private readonly support: SupportAnalytics,
  ) {}

  async tab(
    actor: AdminPrincipal,
    tab: AnalyticsTab,
    dto: AnalyticsFilterDto,
    only?: string[],
    population: PopulationMode = 'all',
    extra: CommunityFilters &
      DealFilters &
      ConnectFilters &
      CommerceFilters &
      ProfessionalFilters &
      SearchFilters &
      SafetyFilters &
      SupportFilters = {},
  ): Promise<{ data: AnalyticsResponse; meta: Record<string, unknown> }> {
    this.assertMayRead(actor, tab);

    if (!this.built.has(tab)) {
      throw ApiException.badRequest(
        ApiErrorCode.NOT_AVAILABLE_YET,
        `The ${tab} tab has not shipped yet.`,
      );
    }

    const filter = await this.filters.resolve(dto);
    const range = filter.range!;
    const available =
      tab === 'demographics'
        ? this.demographics.charts(filter, range, population)
        : tab === 'growth'
          ? this.growth.charts(filter, range, dto)
          : tab === 'community'
            ? this.community.charts(filter, range, { ...extra, cityIds: dto.cityIds })
            : tab === 'deals'
              ? this.deals.charts(filter, range, extra)
              : tab === 'connect'
                ? this.connect.charts(filter, range, extra)
                : tab === 'commerce'
                  ? this.commerce.charts(filter, range, { ...extra, cityIds: dto.cityIds })
                  : tab === 'professionals'
                    ? this.professionals.charts(filter, range, {
                        ...extra,
                        cityIds: dto.cityIds,
                      })
                    : tab === 'search'
                      ? this.search.charts(filter, range, { ...extra, cityIds: dto.cityIds })
                      : tab === 'trust-safety'
                        ? this.safety.charts(filter, range, extra)
                        : tab === 'support'
                          ? this.support.charts(filter, range, extra)
                          : this.overview.charts(filter, range);

    // `charts=` lets the portal lazy-load a tab and re-fetch one chart when its own date selector
    // moves. An unknown id is refused rather than ignored: a chart the portal asked for and did
    // not get back would render as a permanent spinner.
    const wanted = this.narrow(available, only);

    return this.runner.withSlot(actor.id, async () => {
      // Only counted when something actually narrows the population. §2.7's floor is "when
      // **member-attribute filters** narrow the population below 10" — with no filters the
      // population is the whole platform, and blanking the dashboard because a new deployment has
      // eight members would make it useless on exactly the days somebody is watching it. It also
      // saves a count of the view on every unfiltered request.
      const population = dto.hasMemberAttributeFilters
        ? await this.populationSize(filter.viewSql)
        : null;
      const narrowed = population !== null && population > 0 && population < POPULATION_FLOOR;
      const { charts, cache } = await this.runner.charts(
        this.runner.keyFor(
          tab,
          { ...dto, ...extra, charts: only, population },
          this.scopeOf(actor, tab),
        ),
        wanted,
        { includesToday: this.runner.includesToday(range.to) },
      );

      // The population floor: with fewer than ten people selected, every number in the response is
      // about those people, whether or not it is a count of them. "7 requests" from a population of
      // four is still four identifiable people.
      const suppressed = narrowed ? suppressEverything(charts) : charts;

      return {
        data: {
          range: {
            from: range.from,
            to: range.to,
            ...(range.previous
              ? { previousFrom: range.previous.from, previousTo: range.previous.to }
              : {}),
            granularity: range.granularity,
            timezone: 'Europe/London' as const,
          },
          generatedAt: new Date().toISOString(),
          charts: suppressed,
        },
        meta: {
          filtersApplied: filter.applied,
          filtersIgnored: [],
          // What a filter means on this tab, where it is not obvious. On a content tab `cityIds`
          // narrows the content's own city rather than the author's, and a reader comparing two
          // tabs has no other way to know which (§2.5).
          ...(tab === 'community' ? { filterSemantics: CommunityAnalytics.FILTER_SEMANTICS } : {}),
          ...(tab === 'commerce' ? { filterSemantics: CommerceAnalytics.FILTER_SEMANTICS } : {}),
          ...(tab === 'professionals'
            ? { filterSemantics: ProfessionalsAnalytics.FILTER_SEMANTICS }
            : {}),
          ...(tab === 'search' ? { filterSemantics: SearchAnalytics.FILTER_SEMANTICS } : {}),
          ...(tab === 'trust-safety' ? { filterSemantics: SafetyAnalytics.FILTER_SEMANTICS } : {}),
          ...(tab === 'support' ? { filterSemantics: SupportAnalytics.FILTER_SEMANTICS } : {}),
          cache,
          ...(narrowed ? { populationSuppressed: true } : {}),
        },
      };
    });
  }

  /**
   * How many members the filters select.
   *
   * Counted once per request rather than per chart, and only used for the floor — the charts count
   * their own populations. Zero is not suppressed: an empty selection is somebody asking about a
   * city with nobody in it, and telling them "withheld" would imply there is something to withhold.
   */
  private async populationSize(viewSql: Prisma.Sql): Promise<number> {
    const [row] = await this.runner.query(
      tx => tx.$queryRaw<Array<{ total: bigint }>>`
        SELECT COUNT(*) AS total FROM "mv_member_dimensions" m WHERE ${viewSql}
      `,
    );

    return Number(row?.total ?? 0);
  }

  private narrow(
    available: Record<string, () => Promise<Chart>>,
    only?: string[],
  ): Record<string, () => Promise<Chart>> {
    if (!only?.length) return available;

    const unknown = only.filter(id => !(id in available));

    if (unknown.length) {
      throw ApiException.badRequest(
        ApiErrorCode.VALIDATION_FAILED,
        `No such chart: ${unknown.join(', ')}.`,
        { details: [{ field: 'charts', message: `Unknown: ${unknown.join(', ')}.` }] },
      );
    }

    return Object.fromEntries(only.map(id => [id, available[id]]));
  }

  private assertMayRead(actor: AdminPrincipal, tab: AnalyticsTab): void {
    const allowed = TAB_PERMISSIONS[tab];

    if (!allowed.some(permission => actor.permissions.has(permission))) {
      throw ApiException.forbidden(ApiErrorCode.FORBIDDEN, 'You cannot see that tab.');
    }
  }

  /**
   * What goes into the cache key alongside the filters.
   *
   * Two staff members can send identical filters and be entitled to different answers, so the key
   * has to separate them — otherwise one is served the other's payload, which looks like a
   * permission bug and is a cache bug. For these tabs the distinction is which permission opened
   * the tab, since that is what the payload can differ by.
   */
  private scopeOf(actor: AdminPrincipal, tab: AnalyticsTab): string {
    return TAB_PERMISSIONS[tab].filter(permission => actor.permissions.has(permission)).join('+');
  }
}
