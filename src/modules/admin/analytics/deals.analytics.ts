import { Injectable } from '@nestjs/common';
import { Prisma, TaxonomyKind } from '@prisma/client';
import { TaxonomyService } from '@/modules/platform/shared';
import { AnalyticsRunnerService } from './analytics-runner.service';
import {
  BreakdownChart,
  Chart,
  FunnelChart,
  KpiChart,
  Num,
  Point,
  TableChart,
  TimeSeriesChart,
} from './chart.types';
import { Bucket, bucketsFor, indexByDay } from './buckets';
import { toBreakdown } from './breakdown';
import { ResolvedMemberFilter, ResolvedRange } from '../filters/member-filter.builder';
import { DealFilters } from '../dtos/admin-analytics.dto';

/**
 * The deal floor (addendum §4).
 *
 * Ten **deals**, which is a different rule from §2.7's ten members and needs to be: a single deal's
 * value says what two named people charged each other, which is commercially sensitive in a way a
 * member count is not. `dealsAgreed` is exempt — it counts deals rather than revealing a value.
 */
export const DEAL_FLOOR = 10;

/**
 * The eight aggregates every money figure is built from, written once.
 *
 * `totals` selects them over the whole window and `byProfession` selects them grouped by category.
 * Stated here rather than in both places because they are the addendum's definitions in SQL — the
 * `LEAST` cap, the open/done split, the median — and two copies of a definition is one that will
 * drift the first time somebody changes a rule in the place they happened to be looking.
 */
const MONEY_COLUMNS = Prisma.sql`
  SELECT
    COUNT(*)::int AS deals_agreed,
    COUNT(CASE WHEN NOT is_done THEN 1 END)::int AS open_deals,
    COUNT(CASE WHEN is_done THEN 1 END)::int AS done_deals,
    COALESCE(SUM("amount"), 0)::bigint AS agreed_value,
    COALESCE(SUM(recorded_paid), 0)::bigint AS recorded_paid,
    COALESCE(SUM(CASE WHEN NOT is_done THEN "amount" - recorded_paid END), 0)::bigint AS outstanding,
    COALESCE(SUM(CASE WHEN is_done THEN "amount" END), 0)::bigint AS completed_value,
    COALESCE(ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "amount")), 0)::bigint AS median_value`;

/** The stages each track moves through, in order. The enum holds both tracks' stages together. */
const TRACK_STAGES: Record<string, string[]> = {
  COMMERCE: ['AGREED', 'DEPOSIT_PAID', 'PAID', 'DISPATCHED', 'GOODS_RECEIVED', 'DONE'],
  PROFESSIONAL: ['AGREED', 'DEPOSIT_PAID', 'PAID', 'STARTED', 'WORK_DELIVERED', 'ACCEPTED', 'DONE'],
};

/** The two steps that record money changing hands. */
const PAYMENT_STAGES = ['DEPOSIT_PAID', 'PAID'];

/**
 * Deals — recorded values, not payments (§5.25, with `BACKEND-NOTES-DEALS-ANALYTICS.md` merged).
 *
 * Circl takes no money, so every figure here is what two members **said** they agreed and said they
 * paid. That is not a disclaimer, it is the thing that shapes the arithmetic: `recordedPaid` caps
 * each deal's payments at its agreed amount, because a mistyped figure must not make a deal look
 * overpaid or push a total past anything anybody agreed to.
 */
@Injectable()
export class DealsAnalytics {
  constructor(
    private readonly runner: AnalyticsRunnerService,
    private readonly taxonomy: TaxonomyService,
  ) {}

  charts(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: DealFilters,
  ): Record<string, () => Promise<Chart>> {
    return {
      totals: () => this.totals(filter, range, extra),
      byProfession: () => this.byProfession(filter, range, extra),
      dealsByTrack: () => this.dealsByTrack(filter, range, extra),
      agreedValue: () => this.agreedValue(filter, range, extra),
      stageFunnel: () => this.stageFunnel(filter, range, extra),
      completionCancellation: () => this.completionCancellation(filter, range, extra),
      problems: () => this.problems(filter, range, extra),
      paymentTiming: () => this.paymentTiming(filter, range, extra),
    };
  }

  /**
   * The members either side of a deal.
   *
   * A deal has two people, and the member filter has to mean "deals involving these members" rather
   * than picking one side arbitrarily — a city filter that silently meant "deals where the *payer*
   * is in Leeds" would halve the answer with nothing to say so.
   */
  private pop(filter: ResolvedMemberFilter): Prisma.Sql {
    return Prisma.sql`
      pop AS (
        SELECT m."user_id" FROM "mv_member_dimensions" m WHERE ${filter.viewSql}
      )`;
  }

  private tracks(extra: DealFilters): Prisma.Sql {
    return extra.track?.length
      ? Prisma.sql`AND d."track"::text IN (${Prisma.join(extra.track)})`
      : Prisma.empty;
  }

  private timings(extra: DealFilters): Prisma.Sql {
    return extra.timing?.length
      ? Prisma.sql`AND d."timing"::text IN (${Prisma.join(extra.timing)})`
      : Prisma.empty;
  }

  /**
   * Live agreed deals in the range, with each one's money worked out (addendum §2).
   *
   * A deal counts in the period of its `AGREED` step, falling back to `created_at` where no step
   * was recorded. A payment logged two months later does **not** move it — otherwise last month's
   * total would change after the fact, and a figure somebody reported to a board would stop being
   * the figure.
   */
  private live(
    filter: ResolvedMemberFilter,
    window: { from: Date; to: Date },
    extra: DealFilters,
  ): Prisma.Sql {
    return Prisma.sql`
      ${this.pop(filter)},
      live AS (
        SELECT d."id", d."track"::text AS track, d."amount", d."provider_id",
               COALESCE(
                 (SELECT MIN(s."reached_at") FROM "deal_steps" s
                   WHERE s."deal_id" = d."id" AND s."stage" = 'AGREED'),
                 d."created_at"
               ) AS agreed_at,
               -- Capped at the amount agreed. These are self-reported figures, and a deal that
               -- looks overpaid is a typo rather than a fact about money.
               LEAST(
                 d."amount",
                 COALESCE((
                   SELECT SUM(s."amount") FROM "deal_steps" s
                   WHERE s."deal_id" = d."id"
                     AND s."stage"::text IN (${Prisma.join(PAYMENT_STAGES)})
                     AND s."amount" IS NOT NULL
                 ), 0)
               ) AS recorded_paid,
               EXISTS (
                 SELECT 1 FROM "deal_steps" s
                 WHERE s."deal_id" = d."id" AND s."stage" = 'DONE'
               ) AS is_done
        FROM "deals" d
        WHERE d."is_agreed_by_both" = true AND d."is_cancelled" = false
          AND (
            EXISTS (SELECT 1 FROM pop WHERE pop."user_id" = d."payer_id")
            OR EXISTS (SELECT 1 FROM pop WHERE pop."user_id" = d."provider_id")
          )
          ${this.tracks(extra)} ${this.timings(extra)}
      ),
      windowed AS (
        SELECT * FROM live
        WHERE agreed_at >= ${window.from} AND agreed_at < ${window.to}
      )`;
  }

  // ─── The money cards ───────────────────────────────────────────────────────

  /**
   * Six figures, each suppressed by the number of deals behind it rather than by its own size.
   *
   * A value of £40 built from one deal is a disclosure; a value of £40,000 built from two is the
   * same disclosure with more zeroes. So the floor counts contributing deals, and each figure has
   * its own set of them — `completedValue` is built from `DONE` deals, `outstanding` from open ones.
   */
  private async totals(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: DealFilters,
  ): Promise<Chart> {
    const [current, previous] = await Promise.all([
      this.money(filter, extra, { from: range.fromInstant, to: range.toInstant }),
      range.previous
        ? this.money(filter, extra, {
            from: range.previous.fromInstant,
            to: range.previous.toInstant,
          })
        : null,
    ]);

    const card = (
      pick: keyof MoneyRow,
      contributing: keyof MoneyRow,
      unit: KpiChart['unit'],
    ): KpiChart => {
      const enough = (row: MoneyRow | null) =>
        row !== null && Number(row[contributing]) >= DEAL_FLOOR;

      const value = enough(current) ? Number(current[pick]) : null;
      const was = enough(previous) ? Number(previous![pick]) : null;

      return {
        kind: 'kpi',
        value,
        previous: was,
        changePct:
          value !== null && was !== null && was !== 0
            ? Math.round(((value - was) / was) * 1000) / 10
            : null,
        unit,
        sparkline: [],
        ...(value === null ? { suppressed: true as const } : {}),
      };
    };

    return {
      kind: 'group',
      items: {
        // Never suppressed: a count of deals is not a value (addendum §4).
        dealsAgreed: {
          kind: 'kpi',
          value: Number(current.deals_agreed),
          previous: previous ? Number(previous.deals_agreed) : null,
          changePct: null,
          unit: 'count',
          sparkline: [],
        },
        agreedValue: card('agreed_value', 'deals_agreed', 'pence'),
        recordedPaid: card('recorded_paid', 'deals_agreed', 'pence'),
        outstanding: card('outstanding', 'open_deals', 'pence'),
        completedValue: card('completed_value', 'done_deals', 'pence'),
        medianValue: card('median_value', 'deals_agreed', 'pence'),
      },
    };
  }

  private async money(
    filter: ResolvedMemberFilter,
    extra: DealFilters,
    window: { from: Date; to: Date },
  ): Promise<MoneyRow> {
    const [row] = await this.runner.query(
      tx => tx.$queryRaw<MoneyRow[]>`
        WITH ${this.live(filter, window, extra)}
        ${MONEY_COLUMNS}
        FROM windowed
      `,
    );

    return row ?? emptyRow();
  }

  /**
   * The same six figures per professional category (addendum §5).
   *
   * Grouped by the provider's **current** primary category, never by service: service names are
   * free text and would give a row per spelling. Rows are then collapsed until every one is built
   * from at least ten deals — so nothing is hidden, and no value can be recovered by subtracting
   * the rows from the card above. That is §2.7's complementary suppression, applied to a table.
   */
  private async byProfession(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: DealFilters,
  ): Promise<TableChart> {
    const columns = [
      { key: 'profession', label: 'Category' },
      { key: 'dealsAgreed', label: 'Deals', unit: 'count' as const },
      { key: 'agreedValue', label: 'Agreed', unit: 'pence' as const },
      { key: 'recordedPaid', label: 'Recorded paid', unit: 'pence' as const },
      { key: 'outstanding', label: 'Outstanding', unit: 'pence' as const },
      { key: 'completedValue', label: 'Completed', unit: 'pence' as const },
      { key: 'medianValue', label: 'Median', unit: 'pence' as const },
    ];

    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<MoneyRow & { code: string | null }>>`
        WITH ${this.live(filter, rangeWindow(range), { ...extra, track: ['PROFESSIONAL'] })},
        categorised AS (
          SELECT w.*, plc."code" AS code
          FROM windowed w
          LEFT JOIN "professional_listings" pl ON pl."user_id" = w."provider_id"
          LEFT JOIN "professional_listing_categories" plc
            ON plc."listing_id" = pl."id" AND plc."is_primary" = true
        )
        ${MONEY_COLUMNS}, code
        FROM categorised
        GROUP BY code
      `,
    );

    const labels = await this.taxonomy.labels(TaxonomyKind.PROFESSION);
    const collapsed = collapseToFloor(rows);

    if (!collapsed) return { kind: 'table', columns, rows: [] };

    return {
      kind: 'table',
      columns,
      rows: collapsed.map(group => ({
        profession: group.code === null ? group.label : (labels.get(group.code) ?? group.code),
        dealsAgreed: group.row.deals_agreed,
        agreedValue: Number(group.row.agreed_value),
        recordedPaid: Number(group.row.recorded_paid),
        outstanding: Number(group.row.outstanding),
        completedValue: Number(group.row.completed_value),
        // The median of a collapsed row cannot be recovered from the parts, so it is reported only
        // for a row that is one real category. A median of medians is not a median.
        medianValue: group.code === null ? null : Number(group.row.median_value),
      })),
    };
  }

  // ─── The rest of the tab ───────────────────────────────────────────────────

  private async dealsByTrack(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: DealFilters,
  ): Promise<TimeSeriesChart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ track: string; day: Date; total: bigint }>>`
        WITH ${this.pop(filter)}
        SELECT d."track"::text AS track,
               (d."created_at" AT TIME ZONE 'Europe/London')::date AS day,
               COUNT(*) AS total
        FROM "deals" d
        WHERE d."created_at" >= ${range.fromInstant} AND d."created_at" < ${range.toInstant}
          AND (
            EXISTS (SELECT 1 FROM pop WHERE pop."user_id" = d."payer_id")
            OR EXISTS (SELECT 1 FROM pop WHERE pop."user_id" = d."provider_id")
          )
          ${this.tracks(extra)} ${this.timings(extra)}
        GROUP BY 1, 2
      `,
    );

    return {
      kind: 'timeseries',
      granularity: range.granularity,
      unit: 'count',
      series: ['COMMERCE', 'PROFESSIONAL'].map(track => ({
        key: track,
        label: track === 'COMMERCE' ? 'Commerce' : 'Professional',
        points: layOnBuckets(
          buckets,
          rows.filter(row => row.track === track),
        ),
      })),
    };
  }

  /**
   * Agreed value over time, cancelled deals excluded (addendum §3).
   *
   * Bucketed by when the deal was agreed, which is what makes the series total equal the
   * `totals.agreedValue` card. Before the addendum it counted cancelled deals by `created_at`, so
   * the chart and the card disagreed and neither said why.
   */
  private async agreedValue(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: DealFilters,
  ): Promise<TimeSeriesChart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ day: Date; total: bigint; deals: bigint }>>`
        WITH ${this.live(filter, rangeWindow(range), extra)}
        SELECT (agreed_at AT TIME ZONE 'Europe/London')::date AS day,
               SUM("amount") AS total, COUNT(*) AS deals
        FROM windowed
        GROUP BY 1
      `,
    );

    const index = indexByDay(buckets);
    const value = buckets.map(() => 0);
    const deals = buckets.map(() => 0);

    for (const row of rows) {
      const position = index.get(dayKey(row.day));

      if (position === undefined) continue;

      value[position] += Number(row.total);
      deals[position] += Number(row.deals);
    }

    return {
      kind: 'timeseries',
      granularity: range.granularity,
      unit: 'pence',
      series: [
        {
          key: 'agreedValue',
          label: 'Agreed value',
          // The deal floor applies per bucket as well as to the card: a week's total built from
          // three deals is the same disclosure as a card built from three.
          points: buckets.map((bucket, position) => ({
            t: bucket.key,
            v: deals[position] >= DEAL_FLOOR ? value[position] : null,
            ...(deals[position] > 0 && deals[position] < DEAL_FLOOR
              ? { suppressed: true as const }
              : {}),
          })),
        },
      ],
    };
  }

  /** How far deals get, per track, through that track's own sequence of stages. */
  private async stageFunnel(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: DealFilters,
  ): Promise<Chart> {
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ track: string; stage: string; total: bigint }>>`
        WITH ${this.live(filter, rangeWindow(range), extra)}
        SELECT w.track AS track, s."stage"::text AS stage, COUNT(DISTINCT w."id") AS total
        FROM windowed w
        JOIN "deal_steps" s ON s."deal_id" = w."id"
        GROUP BY 1, 2
      `,
    );

    const funnel = (track: string): FunnelChart => {
      const stages = TRACK_STAGES[track];
      const reached = new Map(
        rows.filter(row => row.track === track).map(row => [row.stage, Number(row.total)]),
      );
      const values = stages.map(stage => reached.get(stage) ?? 0);
      const start = values[0];

      return {
        kind: 'funnel',
        // Deals, not members. The deal floor guards *values*; a count of deals that reached a
        // stage is the same kind of figure as `dealsAgreed`, which the addendum exempts.
        unit: 'count',
        steps: stages.map((stage, index) => ({
          key: stage,
          label: stage.charAt(0) + stage.slice(1).toLowerCase().replace(/_/g, ' '),
          value: values[index],
          fromPrevious: index === 0 ? 1 : ratio(values[index], values[index - 1]),
          fromStart: ratio(values[index], start),
        })),
      };
    };

    return {
      kind: 'group',
      items: { COMMERCE: funnel('COMMERCE'), PROFESSIONAL: funnel('PROFESSIONAL') },
    };
  }

  /**
   * What fraction of a bucket's deals finished, and what fraction were called off.
   *
   * Both measured against deals **created** in the bucket rather than against each other, because
   * the two are not complements: a deal can be neither finished nor cancelled, which is most of
   * them most of the time.
   */
  private async completionCancellation(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: DealFilters,
  ): Promise<TimeSeriesChart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ day: Date; total: bigint; completed: bigint; cancelled: bigint }>>`
        WITH ${this.pop(filter)}
        SELECT (d."created_at" AT TIME ZONE 'Europe/London')::date AS day,
               COUNT(*) AS total,
               COUNT(CASE WHEN EXISTS (
                 SELECT 1 FROM "deal_steps" s WHERE s."deal_id" = d."id" AND s."stage" = 'DONE'
               ) THEN 1 END) AS completed,
               COUNT(CASE WHEN d."is_cancelled" THEN 1 END) AS cancelled
        FROM "deals" d
        WHERE d."created_at" >= ${range.fromInstant} AND d."created_at" < ${range.toInstant}
          AND (
            EXISTS (SELECT 1 FROM pop WHERE pop."user_id" = d."payer_id")
            OR EXISTS (SELECT 1 FROM pop WHERE pop."user_id" = d."provider_id")
          )
          ${this.tracks(extra)} ${this.timings(extra)}
        GROUP BY 1
      `,
    );

    const index = indexByDay(buckets);
    const totals = buckets.map(() => 0);
    const completed = buckets.map(() => 0);
    const cancelled = buckets.map(() => 0);

    for (const row of rows) {
      const position = index.get(dayKey(row.day));

      if (position === undefined) continue;

      totals[position] += Number(row.total);
      completed[position] += Number(row.completed);
      cancelled[position] += Number(row.cancelled);
    }

    const rateOf = (numerator: number[]): Point[] =>
      buckets.map((bucket, position) => ({
        t: bucket.key,
        // Null, not zero, where no deal was created: a bucket with nothing in it has no rate.
        v:
          totals[position] > 0
            ? Math.round((numerator[position] / totals[position]) * 1000) / 1000
            : null,
      }));

    return {
      kind: 'timeseries',
      granularity: range.granularity,
      unit: 'ratio',
      series: [
        { key: 'completionRate', label: 'Completed', points: rateOf(completed) },
        { key: 'cancellationRate', label: 'Cancelled', points: rateOf(cancelled) },
      ],
    };
  }

  /** Deals somebody flagged a problem with — the ones support may need to look at. */
  private async problems(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: DealFilters,
  ): Promise<Chart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);
    const [[open], raised] = await Promise.all([
      this.runner.query(
        tx => tx.$queryRaw<Array<{ total: number }>>`
          WITH ${this.pop(filter)}
          SELECT COUNT(*)::int AS total
          FROM "deals" d
          WHERE d."has_problem" = true AND d."is_cancelled" = false
            AND (
              EXISTS (SELECT 1 FROM pop WHERE pop."user_id" = d."payer_id")
              OR EXISTS (SELECT 1 FROM pop WHERE pop."user_id" = d."provider_id")
            )
            ${this.tracks(extra)} ${this.timings(extra)}
        `,
      ),
      this.runner.query(
        tx => tx.$queryRaw<Array<{ day: Date; total: bigint }>>`
          WITH ${this.pop(filter)}
          SELECT (d."problem_at" AT TIME ZONE 'Europe/London')::date AS day, COUNT(*) AS total
          FROM "deals" d
          WHERE d."problem_at" >= ${range.fromInstant} AND d."problem_at" < ${range.toInstant}
            AND (
              EXISTS (SELECT 1 FROM pop WHERE pop."user_id" = d."payer_id")
              OR EXISTS (SELECT 1 FROM pop WHERE pop."user_id" = d."provider_id")
            )
            ${this.tracks(extra)} ${this.timings(extra)}
          GROUP BY 1
        `,
      ),
    ]);

    return {
      kind: 'group',
      items: {
        // A count of deals with a problem, not a value — so the deal floor does not apply, for the
        // same reason it does not apply to `dealsAgreed`.
        open: {
          kind: 'kpi',
          value: Number(open?.total ?? 0),
          previous: null,
          changePct: null,
          unit: 'count',
          sparkline: [],
        },
        trend: {
          kind: 'timeseries',
          granularity: range.granularity,
          unit: 'count',
          series: [
            { key: 'raised', label: 'Problems raised', points: layOnBuckets(buckets, raised) },
          ],
        },
      },
    };
  }

  private async paymentTiming(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: DealFilters,
  ): Promise<BreakdownChart> {
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ key: string | null; total: bigint }>>`
        WITH ${this.pop(filter)}
        SELECT d."timing"::text AS key, COUNT(*) AS total
        FROM "deals" d
        WHERE d."created_at" >= ${range.fromInstant} AND d."created_at" < ${range.toInstant}
          AND (
            EXISTS (SELECT 1 FROM pop WHERE pop."user_id" = d."payer_id")
            OR EXISTS (SELECT 1 FROM pop WHERE pop."user_id" = d."provider_id")
          )
          ${this.tracks(extra)} ${this.timings(extra)}
        GROUP BY 1
      `,
    );

    return toBreakdown(rows, {
      unit: 'count',
      order: ['UPFRONT', 'ON_COMPLETION'],
      labels: new Map([
        ['UPFRONT', 'Paid up front'],
        ['ON_COMPLETION', 'Paid on completion'],
      ]),
    });
  }
}

export interface MoneyRow {
  deals_agreed: number;
  open_deals: number;
  done_deals: number;
  agreed_value: bigint;
  recorded_paid: bigint;
  outstanding: bigint;
  completed_value: bigint;
  median_value: bigint;
}

export interface ProfessionGroup {
  code: string | null;
  label: string;
  row: MoneyRow;
}

/**
 * Collapses category rows until every one is built from at least ten deals (addendum §5).
 *
 * The rule in full: a category with ten or more deals keeps its own row; everything else goes into
 * "Other categories"; if that row is still short, the smallest shown category joins it and the
 * check repeats. If nothing reaches ten, there is a single "All categories" row — and if there are
 * fewer than ten professional deals altogether, there is no table, because any row at all would be
 * one small group wearing a label.
 *
 * Returns null for "no table". The collapsing is here rather than in SQL because it is iterative:
 * each move changes which category is now the smallest.
 */
export const collapseToFloor = (
  rows: Array<MoneyRow & { code: string | null }>,
): ProfessionGroup[] | null => {
  const total = rows.reduce((sum, row) => sum + row.deals_agreed, 0);

  if (total < DEAL_FLOOR) return null;

  const named = rows
    .filter(row => row.deals_agreed >= DEAL_FLOOR && row.code !== null)
    .sort((a, b) => b.deals_agreed - a.deals_agreed)
    .map((row): ProfessionGroup => ({ code: row.code, label: row.code!, row }));

  const rest = rows.filter(row => row.deals_agreed < DEAL_FLOOR || row.code === null);
  let other = rest.reduce<MoneyRow>((merged, row) => add(merged, row), emptyRow());
  let otherDeals = other.deals_agreed;

  // Short, so take from the smallest shown category and try again — which is the same reasoning as
  // §2.7's complementary suppression: a residual too small to show is a residual somebody can
  // subtract their way into.
  while (otherDeals > 0 && otherDeals < DEAL_FLOOR && named.length) {
    const smallest = named.pop()!;

    other = add(other, smallest.row);
    otherDeals = other.deals_agreed;
  }

  if (!otherDeals) return named;

  return [
    ...named,
    { code: null, label: named.length ? 'Other categories' : 'All categories', row: other },
  ];
};

const emptyRow = (): MoneyRow => ({
  deals_agreed: 0,
  open_deals: 0,
  done_deals: 0,
  agreed_value: 0n,
  recorded_paid: 0n,
  outstanding: 0n,
  completed_value: 0n,
  median_value: 0n,
});

/** Sums two groups. Medians are not summable, so the merged row's median is never reported. */
const add = (a: MoneyRow, b: MoneyRow): MoneyRow => ({
  deals_agreed: a.deals_agreed + b.deals_agreed,
  open_deals: a.open_deals + b.open_deals,
  done_deals: a.done_deals + b.done_deals,
  agreed_value: BigInt(a.agreed_value) + BigInt(b.agreed_value),
  recorded_paid: BigInt(a.recorded_paid) + BigInt(b.recorded_paid),
  outstanding: BigInt(a.outstanding) + BigInt(b.outstanding),
  completed_value: BigInt(a.completed_value) + BigInt(b.completed_value),
  median_value: 0n,
});

/** A range as the window `live` takes, so the two never diverge at a call site. */
const rangeWindow = (range: ResolvedRange): { from: Date; to: Date } => ({
  from: range.fromInstant,
  to: range.toInstant,
});

const ratio = (value: number, base: number): Num =>
  base > 0 ? Math.round((value / base) * 1000) / 1000 : null;

const dayKey = (day: Date): string => day.toISOString().slice(0, 10);

const layOnBuckets = (buckets: Bucket[], rows: Array<{ day: Date; total: bigint }>): Point[] => {
  const index = indexByDay(buckets);
  const totals = buckets.map(() => 0);

  for (const row of rows) {
    const position = index.get(dayKey(row.day));

    if (position !== undefined) totals[position] += Number(row.total);
  }

  return buckets.map((bucket, position) => ({ t: bucket.key, v: totals[position] }));
};
