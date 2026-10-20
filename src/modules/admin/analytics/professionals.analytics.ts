import { Injectable } from '@nestjs/common';
import { BriefUrgency, ExperienceLevel, Prisma, TaxonomyKind } from '@prisma/client';
import { TaxonomyService } from '@/modules/platform/shared';
import { AnalyticsRunnerService } from './analytics-runner.service';
import {
  BreakdownChart,
  Chart,
  FunnelChart,
  MatrixChart,
  Num,
  Point,
  TimeSeriesChart,
} from './chart.types';
import { Bucket, bucketsFor, indexByDay } from './buckets';
import { toBreakdown, toMatrix } from './breakdown';
import { ResolvedMemberFilter, ResolvedRange } from '../filters/member-filter.builder';
import { ProfessionalFilters } from '../dtos/admin-analytics.dto';

/** The review contexts that are about professional work, not community help. */
const WORK_REVIEWS = ['PROFESSIONAL', 'BOOKING', 'PRIOR_WORK'];

/**
 * The request funnel: three stages that nest, rather than four states that do not.
 *
 * Written as stages rather than as `ServiceRequestState` values because the states are not a
 * funnel — `NO_MATCH` and `CANCELLED` are both endings, and neither is a later step than
 * `MATCHED`. A funnel whose last bar counted departures would read as "most requests get there".
 *
 * Each stage contains the one after it: everything taken on was offered, and everything offered
 * was submitted. That is what makes "never rises" a property of the data rather than a hope.
 */
const BRIEF_FUNNEL = ['SUBMITTED', 'OFFERED', 'TAKEN_ON'] as const;

/** How many cities the supply and demand matrices share. Both get the same rows and columns. */
const SUPPLY_DEMAND_CITIES = 10;

/**
 * Professionals (§5.25).
 *
 * The tab that has to answer "where are we short of people" — which is why `supplyDemand` is two
 * matrices over **identical** axes rather than one chart of a ratio. A ratio hides which side is
 * small: one listing against two briefs and fifty against a hundred are the same number and
 * completely different problems.
 */
@Injectable()
export class ProfessionalsAnalytics {
  constructor(
    private readonly runner: AnalyticsRunnerService,
    private readonly taxonomy: TaxonomyService,
  ) {}

  static readonly FILTER_SEMANTICS: Record<string, string> = {
    cityIds: "the listing's or brief's own city, not the member's",
  };

  charts(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: ProfessionalFilters,
  ): Record<string, () => Promise<Chart>> {
    return {
      listingsByProfession: () => this.listingsByProfession(filter, extra),
      newListings: () => this.newListings(filter, range, extra),
      acceptingWork: () => this.acceptingWork(filter, extra),
      experienceLevels: () => this.experienceLevels(filter, extra),
      responseTimeByProfession: () => this.responseTimeByProfession(filter, extra),
      ratingsDistribution: () => this.ratingsDistribution(filter, range),
      briefsFunnel: () => this.briefsFunnel(filter, range, extra),
      briefsByCategoryUrgency: () => this.briefsByCategoryUrgency(filter, range, extra),
      supplyDemand: () => this.supplyDemand(filter, range, extra),
    };
  }

  /**
   * Live listings owned by the population, with their primary category.
   *
   * The primary category is the one a listing is *filed* under — a plumber who also does tiling is
   * a plumber for the purposes of "how many plumbers do we have in Leeds". Joined as `LEFT`, so a
   * listing with no category still counts as a listing rather than vanishing from the total.
   */
  private listings(filter: ResolvedMemberFilter, extra: ProfessionalFilters): Prisma.Sql {
    const parts: Prisma.Sql[] = [];

    if (extra.cityIds?.length) {
      parts.push(Prisma.sql`pl."city_id" IN (${Prisma.join(extra.cityIds)})`);
    }

    if (extra.experienceLevels?.length) {
      parts.push(
        Prisma.sql`pl."experience_level"::text IN (${Prisma.join(extra.experienceLevels)})`,
      );
    }

    return Prisma.sql`
      pop AS (
        SELECT m."user_id" FROM "mv_member_dimensions" m WHERE ${filter.viewSql}
      ),
      listings AS (
        SELECT pl."id", pl."user_id", pl."city_id", pl."is_accepting_work",
               pl."experience_level"::text AS experience_level,
               pl."median_response_minutes", pl."created_at",
               plc."code" AS profession
        FROM "professional_listings" pl
        JOIN pop ON pop."user_id" = pl."user_id"
        LEFT JOIN "professional_listing_categories" plc
          ON plc."listing_id" = pl."id" AND plc."is_primary" = true
        WHERE pl."deleted_at" IS NULL${parts.length ? Prisma.sql` AND ${Prisma.join(parts, ' AND ')}` : Prisma.empty}
      )`;
  }

  /** Narrows to the professions asked for, and to regulated ones where `regulated` was sent. */
  private async professionScope(extra: ProfessionalFilters): Promise<Prisma.Sql> {
    const parts: Prisma.Sql[] = [];

    if (extra.professions?.length) {
      parts.push(Prisma.sql`listings."profession" IN (${Prisma.join(extra.professions)})`);
    }

    if (extra.regulated !== undefined) {
      // Which professions are regulated is a taxonomy fact, not a column — it is what makes a
      // profile print the line saying Circl has not verified the credential (D13). Resolved to a
      // list of codes here rather than joined, because the vocabulary is small and cached.
      const codes = await this.regulatedCodes();

      parts.push(
        codes.length
          ? extra.regulated
            ? Prisma.sql`listings."profession" IN (${Prisma.join(codes)})`
            : Prisma.sql`(listings."profession" IS NULL OR listings."profession" NOT IN (${Prisma.join(codes)}))`
          : // No profession is marked regulated, so "regulated: true" selects nothing and
            // "regulated: false" selects everything. Said out loud rather than silently ignored.
            extra.regulated
            ? Prisma.sql`FALSE`
            : Prisma.sql`TRUE`,
      );
    }

    return parts.length ? Prisma.sql`AND ${Prisma.join(parts, ' AND ')}` : Prisma.empty;
  }

  private async regulatedCodes(): Promise<string[]> {
    const terms = await this.taxonomy.list(TaxonomyKind.PROFESSION, false);

    return terms
      .filter(term => (term.metadata as { isRegulated?: boolean } | null)?.isRegulated === true)
      .map(term => term.code);
  }

  // ─── Supply ────────────────────────────────────────────────────────────────

  private async listingsByProfession(
    filter: ResolvedMemberFilter,
    extra: ProfessionalFilters,
  ): Promise<BreakdownChart> {
    const scope = await this.professionScope(extra);
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ key: string | null; total: bigint }>>`
        WITH ${this.listings(filter, extra)}
        SELECT listings."profession" AS key, COUNT(*) AS total
        FROM listings WHERE TRUE ${scope}
        GROUP BY 1
      `,
    );

    return toBreakdown(rows, {
      unit: 'count',
      labels: await this.taxonomy.labels(TaxonomyKind.PROFESSION),
      unknownLabel: 'No category set',
    });
  }

  private async newListings(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: ProfessionalFilters,
  ): Promise<TimeSeriesChart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);
    const scope = await this.professionScope(extra);
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ day: Date; total: bigint }>>`
        WITH ${this.listings(filter, extra)}
        SELECT (listings."created_at" AT TIME ZONE 'Europe/London')::date AS day, COUNT(*) AS total
        FROM listings
        WHERE listings."created_at" >= ${range.fromInstant}
          AND listings."created_at" < ${range.toInstant} ${scope}
        GROUP BY 1
      `,
    );

    return {
      kind: 'timeseries',
      granularity: range.granularity,
      unit: 'count',
      series: [{ key: 'newListings', label: 'New listings', points: layOn(buckets, rows) }],
    };
  }

  /**
   * Who is open to work right now.
   *
   * The single most actionable number on the tab: a city full of listings that are all closed to
   * work is indistinguishable from an empty city to the member trying to hire somebody.
   */
  private async acceptingWork(
    filter: ResolvedMemberFilter,
    extra: ProfessionalFilters,
  ): Promise<BreakdownChart> {
    const scope = await this.professionScope(extra);
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ key: string | null; total: bigint }>>`
        WITH ${this.listings(filter, extra)}
        SELECT CASE WHEN listings."is_accepting_work" THEN 'ACCEPTING' ELSE 'NOT_ACCEPTING' END
                 AS key,
               COUNT(*) AS total
        FROM listings WHERE TRUE ${scope}
        GROUP BY 1
      `,
    );

    return toBreakdown(rows, {
      unit: 'count',
      order: ['ACCEPTING', 'NOT_ACCEPTING'],
      labels: new Map([
        ['ACCEPTING', 'Open to work'],
        ['NOT_ACCEPTING', 'Not taking work'],
      ]),
    });
  }

  private async experienceLevels(
    filter: ResolvedMemberFilter,
    extra: ProfessionalFilters,
  ): Promise<BreakdownChart> {
    const scope = await this.professionScope(extra);
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ key: string | null; total: bigint }>>`
        WITH ${this.listings(filter, extra)}
        SELECT listings."experience_level" AS key, COUNT(*) AS total
        FROM listings WHERE TRUE ${scope}
        GROUP BY 1
      `,
    );

    return toBreakdown(rows, {
      unit: 'count',
      order: [...Object.values(ExperienceLevel)],
      labels: await this.taxonomy.labels(TaxonomyKind.EXPERIENCE_LEVEL),
    });
  }

  /**
   * How quickly each profession replies — a median of the listings' own medians.
   *
   * Stated plainly because it is not the median response time of the profession: it is the typical
   * professional's typical reply, which is the number a member experiences when they message
   * somebody at random. The true median over all messages would need every message, and would be
   * dominated by whoever answers most.
   */
  private async responseTimeByProfession(
    filter: ResolvedMemberFilter,
    extra: ProfessionalFilters,
  ): Promise<BreakdownChart> {
    const scope = await this.professionScope(extra);
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ key: string | null; total: number | null }>>`
        WITH ${this.listings(filter, extra)}
        SELECT listings."profession" AS key,
               PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY listings."median_response_minutes")
                 AS total
        FROM listings
        WHERE listings."median_response_minutes" IS NOT NULL ${scope}
        GROUP BY 1
      `,
    );

    return toBreakdown(
      rows.map(row => ({ key: row.key, total: Math.round(row.total ?? 0) })),
      {
        unit: 'minutes',
        // Medians do not add up, so there is no total and no shares — see `additive` for why a
        // "share of minutes" is worse than no number at all.
        additive: false,
        labels: await this.taxonomy.labels(TaxonomyKind.PROFESSION),
        unknownLabel: 'No category set',
      },
    );
  }

  /**
   * Star ratings for professional work, one to five.
   *
   * Only the three contexts that are about paid or prior work: a community thank-you is a different
   * thing from a review of a job, and mixing them would flatter the professional numbers.
   */
  private async ratingsDistribution(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
  ): Promise<BreakdownChart> {
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ key: string | null; total: bigint }>>`
        WITH pop AS (
          SELECT m."user_id" FROM "mv_member_dimensions" m WHERE ${filter.viewSql}
        )
        SELECT r."rating"::text AS key, COUNT(*) AS total
        FROM "reviews" r
        JOIN pop ON pop."user_id" = r."subject_user_id"
        WHERE r."deleted_at" IS NULL
          AND r."context"::text IN (${Prisma.join(WORK_REVIEWS)})
          AND r."created_at" >= ${range.fromInstant} AND r."created_at" < ${range.toInstant}
        GROUP BY 1
      `,
    );

    return toBreakdown(rows, {
      unit: 'count',
      // Five rows always, so a distribution with no one-star reviews shows an empty bar rather
      // than a four-bar chart that looks like the scale starts at two.
      order: ['1', '2', '3', '4', '5'],
      labels: new Map([
        ['1', '1 star'],
        ['2', '2 stars'],
        ['3', '3 stars'],
        ['4', '4 stars'],
        ['5', '5 stars'],
      ]),
    });
  }

  // ─── Demand ────────────────────────────────────────────────────────────────

  private briefs(filter: ResolvedMemberFilter, extra: ProfessionalFilters): Prisma.Sql {
    const parts: Prisma.Sql[] = [];

    if (extra.cityIds?.length) {
      parts.push(Prisma.sql`mb."city_id" IN (${Prisma.join(extra.cityIds)})`);
    }

    if (extra.urgency?.length) {
      parts.push(Prisma.sql`mb."urgency"::text IN (${Prisma.join(extra.urgency)})`);
    }

    if (extra.professions?.length) {
      parts.push(Prisma.sql`mb."category_code" IN (${Prisma.join(extra.professions)})`);
    }

    return Prisma.sql`
      pop AS (
        SELECT m."user_id" FROM "mv_member_dimensions" m WHERE ${filter.viewSql}
      ),
      briefs AS (
        SELECT mb."id", mb."category_code", mb."urgency"::text AS urgency,
               mb."state"::text AS state, mb."city_id", mb."chosen_listing_id", mb."created_at"
        FROM "managed_briefs" mb
        JOIN pop ON pop."user_id" = mb."user_id"
        ${parts.length ? Prisma.sql`WHERE ${Prisma.join(parts, ' AND ')}` : Prisma.empty}
      )`;
  }

  /**
   * How far requests get: submitted, offered, taken on.
   *
   * A request's state is a single column rather than a history, so "reached" has to be inferred —
   * the same way the enquiry funnel does it, from every fact that evidences it. A request that was
   * answered and closed inside the window was still offered, and the offers table says so whatever
   * the state column now reads. Monotonic by construction, which a funnel read off one column is
   * not: taken literally, a request at `MATCHED` would count in one bar and nowhere else, and the
   * chart would show unrelated bars rather than a funnel.
   */
  private async briefsFunnel(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: ProfessionalFilters,
  ): Promise<FunnelChart> {
    const [row] = await this.runner.query(
      tx => tx.$queryRaw<Array<{ submitted: bigint; offered: bigint; taken_on: bigint }>>`
        WITH ${this.briefs(filter, extra)}
        SELECT COUNT(*) AS submitted,
               -- Staff put it in front of somebody. The state alone is not enough: a request can
               -- be answered and closed within the window, and it was still offered.
               COUNT(CASE WHEN
                 briefs."state" IN ('MATCHING', 'MATCHED')
                 OR EXISTS (
                   SELECT 1 FROM "service_request_offers" o WHERE o."request_id" = briefs."id"
                 )
               THEN 1 END) AS offered,
               -- Somebody took it on, which is the only ending this funnel is measuring.
               COUNT(CASE WHEN
                 briefs."state" = 'MATCHED'
                 OR EXISTS (
                   SELECT 1 FROM "service_request_offers" o
                   WHERE o."request_id" = briefs."id" AND o."status" = 'ACCEPTED'
                 )
               THEN 1 END) AS taken_on
        FROM briefs
        WHERE briefs."created_at" >= ${range.fromInstant}
          AND briefs."created_at" < ${range.toInstant}
      `,
    );

    const values = [
      Number(row?.submitted ?? 0),
      Number(row?.offered ?? 0),
      Number(row?.taken_on ?? 0),
    ];
    const start = values[0];

    return {
      kind: 'funnel',
      // Briefs, not members.
      unit: 'count',
      steps: BRIEF_FUNNEL.map((state, index) => ({
        key: state,
        label: titleise(state),
        value: values[index],
        fromPrevious: index === 0 ? 1 : ratio(values[index], values[index - 1]),
        fromStart: ratio(values[index], start),
      })),
    };
  }

  /** What people are asking for, against how soon they need it. */
  private async briefsByCategoryUrgency(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: ProfessionalFilters,
  ): Promise<MatrixChart> {
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ row: string | null; col: string | null; total: bigint }>>`
        WITH ${this.briefs(filter, extra)}
        SELECT briefs."category_code" AS row, briefs."urgency" AS col, COUNT(*) AS total
        FROM briefs
        WHERE briefs."created_at" >= ${range.fromInstant}
          AND briefs."created_at" < ${range.toInstant}
        GROUP BY 1, 2
      `,
    );

    const labels = await this.taxonomy.labels(TaxonomyKind.PROFESSION);
    // Rows ordered by how many briefs each category drew, so the matrix reads top-down by demand.
    const totals = new Map<string, number>();

    for (const row of rows) {
      const key = row.row ?? 'UNKNOWN';

      totals.set(key, (totals.get(key) ?? 0) + Number(row.total));
    }

    const categories = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);

    return toMatrix(rows, {
      unit: 'count',
      rows: categories.map(code => ({
        key: code,
        label: code === 'UNKNOWN' ? 'No category' : (labels.get(code) ?? code),
      })),
      cols: Object.values(BriefUrgency).map(urgency => ({
        key: urgency,
        label: titleise(urgency),
      })),
    });
  }

  /**
   * Supply against demand, as two matrices over **identical** axes.
   *
   * Two charts rather than one ratio, and that is the decision worth recording. A ratio of 0.5 is
   * one listing against two briefs and fifty against a hundred — the same number, and completely
   * different problems: the first is a gap to fill, the second is a market working. Staff need to
   * see both sides, so they get both sides, on the same rows and columns so the eye can compare
   * cell to cell.
   *
   * Demand is briefs plus bookings plus professional searches, because somebody who searched and
   * found nobody is demand that left no other trace — and is precisely the demand worth knowing
   * about.
   */
  private async supplyDemand(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: ProfessionalFilters,
  ): Promise<Chart> {
    const scope = await this.professionScope(extra);

    const [supply, demand] = await Promise.all([
      this.runner.query(
        tx => tx.$queryRaw<
          Array<{ profession: string | null; city: string | null; total: bigint }>
        >`
          WITH ${this.listings(filter, extra)}
          SELECT listings."profession" AS profession, listings."city_id" AS city, COUNT(*) AS total
          FROM listings WHERE TRUE ${scope}
          GROUP BY 1, 2
        `,
      ),
      this.runner.query(
        tx => tx.$queryRaw<
          Array<{ profession: string | null; city: string | null; total: bigint }>
        >`
          WITH pop AS (
            SELECT m."user_id" FROM "mv_member_dimensions" m WHERE ${filter.viewSql}
          ),
          asked AS (
            SELECT mb."category_code" AS profession, mb."city_id" AS city
            FROM "managed_briefs" mb
            JOIN pop ON pop."user_id" = mb."user_id"
            WHERE mb."created_at" >= ${range.fromInstant} AND mb."created_at" < ${range.toInstant}
            UNION ALL
            SELECT plc."code" AS profession, pl."city_id" AS city
            FROM "bookings" b
            JOIN pop ON pop."user_id" = b."client_id"
            JOIN "professional_listings" pl ON pl."id" = b."listing_id"
            LEFT JOIN "professional_listing_categories" plc
              ON plc."listing_id" = pl."id" AND plc."is_primary" = true
            WHERE b."created_at" >= ${range.fromInstant} AND b."created_at" < ${range.toInstant}
            UNION ALL
            -- Searches that went through the professionals scope, mapped to a profession by the
            -- canonical dictionary. Somebody who searched and found nobody is demand that left no
            -- other trace, and is the demand most worth seeing on this chart.
            --
            -- Joined on (normalised, scope), which is the dictionary's own key, and normalised
            -- with the same expression SearchDemandService uses to build it. Any other spelling of
            -- "normalised" would match a different set of rows and silently undercount — the
            -- dictionary is only usable through the rule that filled it.
            SELECT stc."category_code" AS profession, ae."city_id" AS city
            FROM "activity_events" ae
            JOIN pop ON pop."user_id" = ae."user_id"
            JOIN "search_term_canonical" stc
              ON stc."normalised"
                   = lower(btrim(regexp_replace(ae."term", '[^[:alnum:][:space:]]', '', 'g')))
             AND stc."scope" = ae."scope"
            WHERE ae."verb" = 'SEARCH' AND ae."scope" = 'PROFESSIONALS'
              AND ae."term" IS NOT NULL
              AND stc."category_code" IS NOT NULL
              AND ae."occurred_at" >= ${range.fromInstant}
              AND ae."occurred_at" < ${range.toInstant}
          )
          SELECT profession, city, COUNT(*) AS total FROM asked GROUP BY 1, 2
        `,
      ),
    ]);

    // Identical axes, chosen from both sides together: a profession with listings and no demand
    // matters as much as the reverse, and a shared axis is the only way the two charts can be read
    // against each other.
    const professions = topKeys([...supply, ...demand], row => row.profession, 12);
    const cities = topKeys([...supply, ...demand], row => row.city, SUPPLY_DEMAND_CITIES);

    const [professionLabels, cityNames] = await Promise.all([
      this.taxonomy.labels(TaxonomyKind.PROFESSION),
      this.cityNames(cities),
    ]);

    const axes = {
      unit: 'count' as const,
      rows: professions.map(code => ({
        key: code,
        label: code === 'UNKNOWN' ? 'No category' : (professionLabels.get(code) ?? code),
      })),
      cols: cities.map(city => ({
        key: city,
        label: city === 'UNKNOWN' ? 'No city' : (cityNames.get(city) ?? city),
      })),
    };

    const cells = (
      rows: Array<{ profession: string | null; city: string | null; total: bigint }>,
    ) => rows.map(row => ({ row: row.profession, col: row.city, total: row.total }));

    return {
      kind: 'group',
      items: {
        supply: toMatrix(cells(supply), axes),
        demand: toMatrix(cells(demand), axes),
      },
    };
  }

  private async cityNames(ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();

    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ id: string; name: string }>>`
        SELECT "id", "name" FROM "cities" WHERE "id" IN (${Prisma.join(ids)})
      `,
    );

    return new Map(rows.map(row => [row.id, row.name]));
  }
}

/** The keys with the most behind them, across both sides, so the two matrices share an axis. */
const topKeys = <T>(rows: T[], pick: (row: T) => string | null, limit: number): string[] => {
  const totals = new Map<string, number>();

  for (const row of rows) {
    const key = pick(row) ?? 'UNKNOWN';
    const total = (row as unknown as { total: bigint }).total;

    totals.set(key, (totals.get(key) ?? 0) + Number(total));
  }

  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key]) => key);
};

const ratio = (value: number, base: number): Num =>
  base > 0 ? Math.round((value / base) * 1000) / 1000 : null;

const titleise = (code: string): string =>
  code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, ' ');

const dayKey = (day: Date): string => day.toISOString().slice(0, 10);

const layOn = (buckets: Bucket[], rows: Array<{ day: Date; total: bigint }>): Point[] => {
  const index = indexByDay(buckets);
  const totals = buckets.map(() => 0);

  for (const row of rows) {
    const position = index.get(dayKey(row.day));

    if (position !== undefined) totals[position] += Number(row.total);
  }

  return buckets.map((bucket, position) => ({ t: bucket.key, v: totals[position] }));
};
