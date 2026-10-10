import { Injectable } from '@nestjs/common';
import { Gender, Prisma, TaxonomyKind } from '@prisma/client';
import { birthDateRangeForAges, londonMidnight, shiftDateOnly } from '@/common';
import { TaxonomyService, toCountryView } from '@/modules/platform/shared';
import { AnalyticsRunnerService } from './analytics-runner.service';
import { BreakdownChart, Chart, MatrixChart } from './chart.types';
import { CountedRow, toBreakdown, toMatrix } from './breakdown';
import { ResolvedMemberFilter, ResolvedRange } from '../filters/member-filter.builder';

/** The gender values, plus the one that is the absence of one. `UNKNOWN` is a group, not a gap. */
const GENDERS = [...Object.values(Gender), 'UNKNOWN'] as const;

/**
 * Who the tab is about: everybody as of `to`, or only those who joined inside the range.
 *
 * Two genuinely different questions. "What does our membership look like" is the first; "who have
 * we been attracting lately" is the second, and reading one as the other is how a platform
 * concludes its audience has changed when all that changed was the date picker.
 */
export type Population = 'all' | 'signups';

/**
 * The Demographics tab (§5.25).
 *
 * Every chart here is a count of distinct members in a sub-group, which makes this the tab
 * suppression exists for: a cell reading "Leeds · non-binary · 1" names somebody to anybody who
 * knows one fact about them. So every number leaves here as a raw count and the runner withholds
 * the small ones before anything is cached or sent.
 *
 * All nine come off `mv_member_dimensions`, which is the point of the view — nine queries that
 * would each otherwise join `users` to `user_profile` to `cities` and unpack two JSONB arrays.
 */
@Injectable()
export class DemographicsAnalytics {
  constructor(
    private readonly runner: AnalyticsRunnerService,
    private readonly taxonomy: TaxonomyService,
  ) {}

  charts(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    population: Population,
  ): Record<string, () => Promise<Chart>> {
    const pop = this.pop(filter, range, population);

    return {
      gender: () => this.gender(pop),
      ageBands: () => this.ageBands(pop, range.to),
      genderByAge: () => this.genderByAge(pop, range.to),
      countries: () => this.countries(pop),
      heritage: () => this.heritage(pop),
      journeyStages: () => this.journeyStages(pop),
      interests: () => this.multiValued(pop, 'interests', TaxonomyKind.INTEREST),
      languages: () => this.multiValued(pop, 'languages', TaxonomyKind.LANGUAGE),
      cityByJourneyStage: () => this.cityByJourneyStage(pop),
    };
  }

  /**
   * The population, as a CTE.
   *
   * `all` is everybody who had joined by the end of the range — not everybody who exists now, which
   * would put today's membership next to last month's charts.
   */
  private pop(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    population: Population,
  ): Prisma.Sql {
    const window =
      population === 'signups'
        ? Prisma.sql`m."created_day" >= ${range.from}::date AND m."created_day" <= ${range.to}::date`
        : Prisma.sql`m."created_day" <= ${range.to}::date`;

    return Prisma.sql`
      pop AS (
        SELECT m."user_id", m."gender", m."date_of_birth", m."country_code",
               m."heritage_tag", m."journey_stage", m."city_id", m."interests", m."languages"
        FROM "mv_member_dimensions" m
        WHERE ${filter.viewSql} AND ${window}
      )`;
  }

  private async gender(pop: Prisma.Sql): Promise<BreakdownChart> {
    const rows = await this.count(pop, Prisma.sql`pop."gender"`);
    const labels = await this.labels(TaxonomyKind.GENDER);

    return toBreakdown(rows, { order: [...GENDERS], labels, unknownLabel: 'Not said' });
  }

  /**
   * Age bands, derived from the birth date at the end of the range.
   *
   * At `to` rather than at render time, so the same range gives the same answer a week later — and
   * so the band a member is counted in matches the band the member filter would have selected them
   * by. The bounds come from the `CONNECT_AGE_BAND` taxonomy, which is where staff can reword them.
   */
  private async ageBands(pop: Prisma.Sql, to: string): Promise<BreakdownChart> {
    const bands = await this.bands();
    const rows = await this.count(pop, this.bandExpression(bands, to));

    return toBreakdown(rows, {
      order: [...bands.map(band => band.code), 'UNKNOWN'],
      labels: new Map(bands.map(band => [band.code, band.label])),
      unknownLabel: 'No date of birth',
    });
  }

  /** Age against gender, which is the cross the Connect section is designed around. */
  private async genderByAge(pop: Prisma.Sql, to: string): Promise<MatrixChart> {
    const bands = await this.bands();
    const genderLabels = await this.labels(TaxonomyKind.GENDER);
    const band = this.bandExpression(bands, to);

    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ row: string | null; col: string | null; total: bigint }>>`
        WITH ${pop}
        SELECT ${band} AS row, pop."gender" AS col, COUNT(*) AS total
        FROM pop
        GROUP BY 1, 2
      `,
    );

    return toMatrix(rows, {
      rows: [
        ...bands.map(band => ({ key: band.code, label: band.label })),
        { key: 'UNKNOWN', label: 'No date of birth' },
      ],
      cols: GENDERS.map(gender => ({
        key: gender,
        label: gender === 'UNKNOWN' ? 'Not said' : (genderLabels.get(gender) ?? gender),
      })),
    });
  }

  /** Countries of origin, named from ICU rather than from a list anybody maintains. */
  private async countries(pop: Prisma.Sql): Promise<BreakdownChart> {
    const rows = await this.count(pop, Prisma.sql`pop."country_code"`);
    const labels = new Map(
      rows
        .map(row => (row.key ? toCountryView(row.key) : null))
        .filter((view): view is { code: string; label: string } => view !== null)
        .map(view => [view.code, view.label]),
    );

    return toBreakdown(rows, { top: 15, labels, unknownLabel: 'Not said' });
  }

  private async heritage(pop: Prisma.Sql): Promise<BreakdownChart> {
    const rows = await this.count(pop, Prisma.sql`pop."heritage_tag"`);

    return toBreakdown(rows, { labels: await this.labels(TaxonomyKind.HERITAGE_TAG) });
  }

  /** Journey stages, in the taxonomy's own order — this is a funnel, so the order is the meaning. */
  private async journeyStages(pop: Prisma.Sql): Promise<BreakdownChart> {
    const terms = await this.taxonomy.list(TaxonomyKind.JOURNEY_STAGE, false);
    const rows = await this.count(pop, Prisma.sql`pop."journey_stage"`);

    return toBreakdown(rows, {
      order: [...terms.map(term => term.code), 'UNKNOWN'],
      labels: new Map(terms.map(term => [term.code, term.label])),
      unknownLabel: 'Not said',
    });
  }

  /**
   * Interests and languages, which a member can hold several of.
   *
   * `unnest` the array and count distinct members per code, with the **member count** as the
   * denominator. Dividing by the sum of the groups instead would give shares adding to four hundred
   * per cent on a platform where people pick four interests each — technically a share of
   * selections, and not what anybody reads the bar as.
   */
  private async multiValued(
    pop: Prisma.Sql,
    column: 'interests' | 'languages',
    kind: TaxonomyKind,
  ): Promise<BreakdownChart> {
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ key: string | null; total: bigint; members: bigint }>>`
        WITH ${pop},
        spread AS (
          SELECT pop."user_id", code
          FROM pop
          CROSS JOIN LATERAL unnest(pop.${Prisma.raw(`"${column}"`)}) AS code
        )
        SELECT code AS key,
               COUNT(DISTINCT "user_id") AS total,
               (SELECT COUNT(*) FROM pop) AS members
        FROM spread
        GROUP BY 1
      `,
    );

    return toBreakdown(rows, {
      top: 20,
      labels: await this.labels(kind),
      total: Number(rows[0]?.members ?? 0),
    });
  }

  /** The fifteen biggest cities against journey stage: where people are, and how settled. */
  private async cityByJourneyStage(pop: Prisma.Sql): Promise<MatrixChart> {
    const terms = await this.taxonomy.list(TaxonomyKind.JOURNEY_STAGE, false);
    const rows = await this.runner.query(
      tx => tx.$queryRaw<
        Array<{ row: string | null; label: string | null; col: string | null; total: bigint }>
      >`
        WITH ${pop},
        -- The top cities decided first, so the matrix has fifteen rows rather than one per city
        -- and every row is one the reader can see on the chart.
        top_cities AS (
          SELECT pop."city_id" AS city_id, COUNT(*) AS members
          FROM pop
          WHERE pop."city_id" IS NOT NULL
          GROUP BY 1
          ORDER BY members DESC
          LIMIT 15
        )
        SELECT pop."city_id" AS row, c."name" AS label, pop."journey_stage" AS col, COUNT(*) AS total
        FROM pop
        JOIN top_cities t ON t.city_id = pop."city_id"
        LEFT JOIN "cities" c ON c."id" = pop."city_id"
        GROUP BY 1, 2, 3
      `,
    );

    const cityLabels = new Map(
      rows.filter(row => row.row).map(row => [row.row as string, row.label ?? (row.row as string)]),
    );

    // Ordered by total members, so the matrix reads top-down like the breakdown beside it.
    const totals = new Map<string, number>();

    for (const row of rows) {
      if (!row.row) continue;

      totals.set(row.row, (totals.get(row.row) ?? 0) + Number(row.total));
    }

    const cities = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([city]) => city);

    return toMatrix(rows, {
      rows: cities.map(city => ({ key: city, label: cityLabels.get(city) ?? city })),
      cols: [
        ...terms.map(term => ({ key: term.code, label: term.label })),
        { key: 'UNKNOWN', label: 'Not said' },
      ],
    });
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /** One grouped count over the population, by any expression. */
  private async count(pop: Prisma.Sql, expression: Prisma.Sql): Promise<CountedRow[]> {
    return this.runner.query(
      tx => tx.$queryRaw<CountedRow[]>`
        WITH ${pop}
        SELECT ${expression} AS key, COUNT(*) AS total
        FROM pop
        GROUP BY 1
      `,
    );
  }

  /**
   * The band a birth date falls in at a given date, as a SQL `CASE`.
   *
   * Built from the taxonomy's bounds and the same `birthDateRangeForAges` the member filter uses,
   * so a member counted in a band is a member that band's filter would have selected. Computed in
   * SQL rather than per row in TypeScript, because the alternative is reading every member's birth
   * date out of the database to bucket them.
   */
  private bandExpression(
    bands: Array<{ code: string; minAge: number; maxAge: number | null }>,
    to: string,
  ): Prisma.Sql {
    const at = londonMidnight(shiftDateOnly(to, 1));
    const branches = bands.map(band => {
      const window = birthDateRangeForAges(band.minAge, band.maxAge ?? undefined, at);
      const tests = [
        window.earliest ? Prisma.sql`pop."date_of_birth" > ${window.earliest}` : null,
        window.latest ? Prisma.sql`pop."date_of_birth" <= ${window.latest}` : null,
      ].filter((test): test is Prisma.Sql => test !== null);

      return Prisma.sql`WHEN ${Prisma.join(tests, ' AND ')} THEN ${band.code}`;
    });

    // No `ELSE`: a null band is "no date of birth, or an age no band covers", and both are
    // genuinely unknown. Inventing an "other" bucket would hide a gap in the vocabulary.
    return Prisma.sql`CASE ${Prisma.join(branches, ' ')} END`;
  }

  private async bands(): Promise<
    Array<{ code: string; label: string; minAge: number; maxAge: number | null }>
  > {
    const terms = await this.taxonomy.list(TaxonomyKind.CONNECT_AGE_BAND, false);

    return terms
      .map(term => {
        const metadata = (term.metadata ?? {}) as { minAge?: number; maxAge?: number | null };

        return typeof metadata.minAge === 'number'
          ? {
              code: term.code,
              label: term.label,
              minAge: metadata.minAge,
              maxAge: metadata.maxAge ?? null,
            }
          : null;
      })
      .filter(
        (band): band is { code: string; label: string; minAge: number; maxAge: number | null } =>
          band !== null,
      );
  }

  private async labels(kind: TaxonomyKind): Promise<Map<string, string>> {
    return this.taxonomy.labels(kind);
  }
}
