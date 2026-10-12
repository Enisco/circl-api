import { Injectable } from '@nestjs/common';
import { Prisma, SearchScope, SuggestionSurface, TaxonomyKind } from '@prisma/client';
import { TaxonomyService } from '@/modules/platform/shared';
import { AnalyticsRunnerService } from './analytics-runner.service';
import { Chart, MatrixChart, Num, Point, TableChart, TimeSeriesChart } from './chart.types';
import { Bucket, bucketsFor, indexByDay } from './buckets';
import { toMatrix } from './breakdown';
import { SUPPRESSION_FLOOR } from './suppression';
import { ResolvedMemberFilter, ResolvedRange } from '../filters/member-filter.builder';
import { SearchFilters } from '../dtos/admin-analytics.dto';

/** How many rows a terms table returns. Long enough to scroll, short enough to read. */
const TERM_ROWS = 20;

/**
 * How many members must have searched a failing term before it is listed.
 *
 * Lower than §2.7's floor of ten, and that is a deliberate decision rather than an oversight.
 *
 * The rule's floor governs a *published count of members*, and this table publishes none — it
 * reports how many searches happened, not how many people made them. What needs justifying is the
 * row's existence, because a search term is free text somebody typed: "sickle cell clinic leeds",
 * searched once, next to the day it happened, is a fact about one person.
 *
 * At ten the chart would be empty for the first year, which defeats it: the whole point is to find
 * the gap *before* it has disappointed a hundred people. At three the row means "several people,
 * independently, looked for this and found nothing" — which is both the useful signal and no
 * longer one person's words. One member's unanswered search is in any case indistinguishable from
 * a typo.
 */
const ZERO_RESULT_FLOOR = 3;

/** How many cities the demand matrix shows. */
const DEMAND_CITIES = 12;

/** How many categories the demand matrix shows. */
const DEMAND_CATEGORIES = 15;

/**
 * Which suggestion surface each search scope's demand is recorded against.
 *
 * The two vocabularies were built for different jobs — a scope is where somebody searched, a
 * surface is what the demand job thinks could satisfy them — so the `scopes` filter has to be
 * translated before it can narrow `demand_signals`. `GUIDES` maps to nothing, because a guide is
 * written rather than supplied and the job computes no signal for it.
 */
const SCOPE_SURFACES: Record<SearchScope, SuggestionSurface[]> = {
  [SearchScope.COMMUNITY]: [SuggestionSurface.COMMUNITY_OFFER, SuggestionSurface.COMMUNITY_REQUEST],
  [SearchScope.REQUESTS]: [SuggestionSurface.COMMUNITY_REQUEST],
  [SearchScope.PROFESSIONALS]: [SuggestionSurface.PROFESSIONAL_SERVICE],
  [SearchScope.PRODUCTS]: [SuggestionSurface.STORE_ITEM],
  [SearchScope.GUIDES]: [],
};

/**
 * The normalisation the canonical dictionary was built with.
 *
 * `SearchDemandService` writes `search_term_canonical.normalised` with exactly this expression, so
 * any join to it has to repeat it. A different spelling of "normalised" — trimming without
 * lowercasing, stripping a different character class — matches a different set of rows and
 * silently undercounts, which looks like a quiet platform rather than a broken join.
 */
const NORMALISED = Prisma.sql`lower(btrim(regexp_replace(ae."term", '[^[:alnum:][:space:]]', '', 'g')))`;

/**
 * Search & Demand (§5.25).
 *
 * The tab that answers "what are people looking for that we do not have". Two of its four charts
 * are tables of **free text members typed**, which makes it the one tab where the privacy question
 * is about the rows rather than the numbers: a count can be withheld, but a search term is itself
 * the disclosure. Both tables are therefore built from the canonical dictionary rather than from
 * raw input, junk is excluded, and a term has to have been searched by several people before it is
 * named at all.
 */
@Injectable()
export class SearchAnalytics {
  constructor(
    private readonly runner: AnalyticsRunnerService,
    private readonly taxonomy: TaxonomyService,
  ) {}

  static readonly FILTER_SEMANTICS: Record<string, string> = {
    cityIds: "the city the search was made from, not the searcher's home city",
    demandGaps:
      'reads scores a nightly job computed over its own window, so neither the date range nor ' +
      'the member attribute filters narrow it — a precomputed signal has no member attached. ' +
      '`cityIds` and `scopes` do narrow it, because a signal carries a city and a surface. Its ' +
      '`window` says what period the scores cover.',
  };

  charts(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: SearchFilters,
  ): Record<string, () => Promise<Chart>> {
    return {
      topTerms: () => this.topTerms(filter, range, extra),
      zeroResultTerms: () => this.zeroResultTerms(filter, range, extra),
      volumeBySection: () => this.volumeBySection(filter, range, extra),
      demandGaps: () => this.demandGaps(extra),
    };
  }

  /**
   * Searches made by the population, canonicalised, with junk dropped.
   *
   * Joined to the dictionary rather than grouped on the raw term, so "plumber", "Plumber" and
   * "plumber!" are one row. The join is inner on purpose: a term the dictionary has never resolved
   * is a term nothing has decided is safe to show, and this tab displays what it selects.
   */
  private searches(filter: ResolvedMemberFilter, extra: SearchFilters): Prisma.Sql {
    const parts: Prisma.Sql[] = [];

    if (extra.scopes?.length) {
      parts.push(Prisma.sql`ae."scope"::text IN (${Prisma.join(extra.scopes)})`);
    }

    if (extra.cityIds?.length) {
      parts.push(Prisma.sql`ae."city_id" IN (${Prisma.join(extra.cityIds)})`);
    }

    return Prisma.sql`
      pop AS (
        SELECT m."user_id" FROM "mv_member_dimensions" m WHERE ${filter.viewSql}
      ),
      searches AS (
        SELECT ae."user_id", ae."scope"::text AS scope, ae."had_results", ae."occurred_at",
               stc."canonical" AS term
        FROM "activity_events" ae
        JOIN pop ON pop."user_id" = ae."user_id"
        JOIN "search_term_canonical" stc
          ON stc."normalised" = ${NORMALISED} AND stc."scope" = ae."scope"
        WHERE ae."verb" = 'SEARCH'
          AND ae."term" IS NOT NULL
          AND ae."scope" IS NOT NULL
          -- Junk is a term the resolver decided is not worth showing anybody: a mistype, a pasted
          -- url, a single letter. Including it would fill the top of the table with noise.
          AND stc."source" <> 'JUNK'
          ${parts.length ? Prisma.sql`AND ${Prisma.join(parts, ' AND ')}` : Prisma.empty}
      )`;
  }

  /**
   * What people search for most, and how often it finds them something.
   *
   * `uniqueSearchers` is a count of distinct members, so §2.7's floor of ten applies — and here it
   * applies to the **row**, not the cell: withholding the number while still printing the term
   * would say "fewer than ten people searched for this", which is the disclosure. The floor is in
   * the `HAVING`, because only the query knows that the term and the count are the same fact.
   */
  private async topTerms(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: SearchFilters,
  ): Promise<TableChart> {
    const rows = await this.runner.query(
      tx => tx.$queryRaw<
        Array<{
          term: string;
          scope: string;
          searches: bigint;
          searchers: bigint;
          answered: bigint;
          found: bigint;
        }>
      >`
        WITH ${this.searches(filter, extra)}
        SELECT searches."term" AS term, searches."scope" AS scope,
               COUNT(*) AS searches,
               COUNT(DISTINCT searches."user_id") AS searchers,
               COUNT(searches."had_results") AS answered,
               COUNT(CASE WHEN searches."had_results" THEN 1 END) AS found
        FROM searches
        WHERE searches."occurred_at" >= ${range.fromInstant}
          AND searches."occurred_at" < ${range.toInstant}
        GROUP BY 1, 2
        HAVING COUNT(DISTINCT searches."user_id") >= ${SUPPRESSION_FLOOR}
        ORDER BY 3 DESC, 1 ASC
        LIMIT ${TERM_ROWS}
      `,
    );

    return {
      kind: 'table',
      columns: [
        { key: 'term', label: 'Term' },
        // The `SearchScope` code rather than a humanised label, so a row can be clicked through
        // to that section's own filters. The portal renders these enums everywhere else.
        { key: 'scope', label: 'Section' },
        { key: 'searches', label: 'Searches', unit: 'count' },
        { key: 'uniqueSearchers', label: 'Members', unit: 'members' },
        { key: 'resultRate', label: 'Found something', unit: 'percent' },
      ],
      rows: rows.map(row => ({
        term: row.term,
        scope: row.scope,
        searches: Number(row.searches),
        uniqueSearchers: Number(row.searchers),
        // Over the searches that recorded an outcome, not over all of them. An event written before
        // the flag existed, or by a path that does not set it, is unknown rather than a failure —
        // counting it as one would make the platform look worse the older the data gets.
        resultRate: rate(Number(row.found), Number(row.answered)),
      })),
    };
  }

  /**
   * What people looked for and did not find.
   *
   * The most actionable chart on the tab and the most sensitive, for the same reason: it is a list
   * of things members wanted that the platform could not supply, in their own words. Listed only
   * where several people searched it (see `ZERO_RESULT_FLOOR`), and dated to the **day** rather
   * than the moment — a term beside a timestamp can be matched to one session, and the day is all
   * anybody needs in order to act on it.
   */
  private async zeroResultTerms(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: SearchFilters,
  ): Promise<TableChart> {
    const rows = await this.runner.query(
      tx => tx.$queryRaw<
        Array<{ term: string; scope: string; searches: bigint; last_searched: Date }>
      >`
        WITH ${this.searches(filter, extra)}
        SELECT searches."term" AS term, searches."scope" AS scope,
               COUNT(*) AS searches,
               MAX((searches."occurred_at" AT TIME ZONE 'Europe/London')::date) AS last_searched
        FROM searches
        WHERE searches."had_results" = false
          AND searches."occurred_at" >= ${range.fromInstant}
          AND searches."occurred_at" < ${range.toInstant}
        GROUP BY 1, 2
        HAVING COUNT(DISTINCT searches."user_id") >= ${ZERO_RESULT_FLOOR}
        ORDER BY 3 DESC, 1 ASC
        LIMIT ${TERM_ROWS}
      `,
    );

    return {
      kind: 'table',
      columns: [
        { key: 'term', label: 'Term' },
        { key: 'scope', label: 'Section' },
        { key: 'searches', label: 'Searches', unit: 'count' },
        { key: 'lastSearchedAt', label: 'Last searched' },
      ],
      rows: rows.map(row => ({
        term: row.term,
        scope: row.scope,
        searches: Number(row.searches),
        lastSearchedAt: dayKey(row.last_searched),
      })),
    };
  }

  /**
   * Searching, by section, over time.
   *
   * Every scope gets a series whether or not it was used, because a section nobody searched is the
   * finding — a missing line reads as a chart that has not loaded.
   */
  private async volumeBySection(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: SearchFilters,
  ): Promise<TimeSeriesChart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ scope: string; day: Date; total: bigint }>>`
        WITH ${this.searches(filter, extra)}
        SELECT searches."scope" AS scope,
               (searches."occurred_at" AT TIME ZONE 'Europe/London')::date AS day,
               COUNT(*) AS total
        FROM searches
        WHERE searches."occurred_at" >= ${range.fromInstant}
          AND searches."occurred_at" < ${range.toInstant}
        GROUP BY 1, 2
      `,
    );

    const wanted = extra.scopes?.length
      ? Object.values(SearchScope).filter(scope => extra.scopes!.includes(scope))
      : Object.values(SearchScope);

    return {
      kind: 'timeseries',
      granularity: range.granularity,
      // Searches, not searchers. One member looking for a plumber eight times is eight searches,
      // and that persistence is the point of the chart.
      unit: 'count',
      series: wanted.map(scope => ({
        key: scope,
        label: titleise(scope),
        points: layOn(
          buckets,
          rows.filter(row => row.scope === scope),
        ),
      })),
    };
  }

  /**
   * Where demand outruns supply, as the nightly job scored it.
   *
   * Not computed here, and that is the thing to know about this chart. `demand_signals` is a
   * snapshot over the job's own window, so neither the date picker nor the member filters narrow
   * it — a precomputed row has no member attached to filter by. The window travels with the chart
   * so the card can print it, because a chart whose numbers do not move when the range does is
   * otherwise indistinguishable from a broken one.
   *
   * Where two surfaces score the same city and category, the cell takes the **higher** score.
   * Summing would invent a number with no scale — the score is demand relative to supply, not a
   * quantity — and averaging would dilute a real shortage in one surface with an easy market in
   * another.
   */
  private async demandGaps(extra: SearchFilters): Promise<MatrixChart> {
    const parts: Prisma.Sql[] = [];

    if (extra.cityIds?.length) {
      parts.push(Prisma.sql`ds."city_id" IN (${Prisma.join(extra.cityIds)})`);
    }

    if (extra.scopes?.length) {
      const surfaces = [
        ...new Set(extra.scopes.flatMap(scope => SCOPE_SURFACES[scope as SearchScope] ?? [])),
      ];

      // A scope with no surface behind it — `GUIDES` — selects nothing rather than everything. An
      // ignored filter would show the whole platform's gaps under a heading saying "Guides".
      parts.push(
        surfaces.length
          ? Prisma.sql`ds."surface"::text IN (${Prisma.join(surfaces)})`
          : Prisma.sql`FALSE`,
      );
    }

    const rows = await this.runner.query(
      tx => tx.$queryRaw<
        Array<{
          city: string | null;
          code: string | null;
          label: string | null;
          score: number;
          window_start: Date;
          window_end: Date;
          computed_at: Date;
        }>
      >`
        SELECT
          -- "demand_signals" stores an absent city, code or term as the empty string rather than
          -- null, because its unique key is composite and Postgres treats nulls as distinct — an
          -- upsert on a nullable key would insert a second row every night. The blanks are
          -- deliberate upstream, and have to be folded back to null here or they key a column of
          -- their own: thirteen different uncoded terms arrived as one blank column, summed
          -- together, labelled after whichever of them sorted first.
          NULLIF(ds."city_id", '') AS city,
          COALESCE(NULLIF(ds."code", ''), NULLIF(ds."term", '')) AS code,
          -- Grouped to exactly one row per cell, keyed the way the matrix keys it. toMatrix sums
          -- rows that land on the same cell, which is right for a count and wrong for a score —
          -- demand relative to supply is not additive, so two surfaces scoring the same city and
          -- category would have produced an invented number with no scale. The higher of the two
          -- is the honest answer: the worst shortage in that cell.
          MAX(ds."score") AS score,
          MIN(ds."label") AS label,
          MIN(ds."window_start") AS window_start, MAX(ds."window_end") AS window_end,
          MAX(ds."computed_at") AS computed_at
        FROM "demand_signals" ds
        ${parts.length ? Prisma.sql`WHERE ${Prisma.join(parts, ' AND ')}` : Prisma.empty}
        GROUP BY 1, 2
      `,
    );

    const cities = topKeys(rows, row => row.city, DEMAND_CITIES);
    const categories = topKeys(rows, row => row.code, DEMAND_CATEGORIES);
    const [cityNames, labels] = await Promise.all([this.cityNames(cities), this.categoryLabels()]);

    // The job's own window, taken from the rows the chart is actually showing, so a filtered view
    // cannot print the window of rows it left out.
    const window = rows.length
      ? {
          from: dayKey(new Date(Math.min(...rows.map(row => row.window_start.getTime())))),
          to: dayKey(new Date(Math.max(...rows.map(row => row.window_end.getTime())))),
          computedAt: new Date(
            Math.max(...rows.map(row => row.computed_at.getTime())),
          ).toISOString(),
        }
      : undefined;

    const matrix = toMatrix(
      rows.map(row => ({ row: row.city, col: row.code, total: row.score })),
      {
        // The score is demand over supply, not a count of anything, so no floor applies to it —
        // and nothing about it is a count of members.
        unit: 'ratio',
        rows: cities.map(city => ({
          key: city,
          label: city === 'UNKNOWN' ? 'No city' : (cityNames.get(city) ?? city),
        })),
        cols: categories.map(code => ({
          key: code,
          // A signal is either a taxonomy code or a bare term the job could not resolve. For the
          // latter the job's own stored label is the best name, because it is the words a member
          // typed — which is the whole point of showing the row at all.
          label:
            code === 'UNKNOWN'
              ? 'Unresolved'
              : (labels.get(code) ?? rows.find(row => row.code === code)?.label ?? code),
        })),
      },
    );

    return window ? { ...matrix, window } : matrix;
  }

  /** Every vocabulary a demand signal can name, in one lookup. */
  private async categoryLabels(): Promise<Map<string, string>> {
    const kinds = [
      TaxonomyKind.PROFESSION,
      TaxonomyKind.ITEM_CATEGORY,
      TaxonomyKind.COMMUNITY_CATEGORY,
    ];
    const maps = await Promise.all(kinds.map(kind => this.taxonomy.labels(kind)));

    return new Map(maps.flatMap(map => [...map.entries()]));
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

/** The keys carrying the most, so a matrix shows the rows worth looking at. */
const topKeys = <T extends { score: number }>(
  rows: T[],
  pick: (row: T) => string | null,
  limit: number,
): string[] => {
  const totals = new Map<string, number>();

  for (const row of rows) {
    const key = pick(row) ?? 'UNKNOWN';

    totals.set(key, Math.max(totals.get(key) ?? 0, row.score));
  }

  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key]) => key);
};

const rate = (part: number, whole: number): Num =>
  whole > 0 ? Math.round((part / whole) * 10_000) / 100 : null;

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
