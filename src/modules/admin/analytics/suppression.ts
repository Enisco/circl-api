import {
  BreakdownChart,
  Chart,
  KpiChart,
  MapChart,
  MatrixChart,
  Num,
  Point,
  TimeSeriesChart,
} from './chart.types';

/**
 * Small-number suppression (§2.7).
 *
 * Any number that counts distinct members, or is derived from one, is withheld below ten. The
 * reason is not squeamishness about statistics: a breakdown saying "Leeds · non-binary · 1" names
 * somebody to anybody who knows one fact about them, and a staff member browsing demographics has
 * not asked to know who that is.
 *
 * Zero is never suppressed — zero identifies nobody, and hiding it would make an empty city look
 * like a small one.
 *
 * Applied after computation and before caching (§8.4), so the raw value never leaves the process
 * and a cached payload is already safe to serve to anyone who can see that tab.
 */
export const SUPPRESSION_FLOOR = 10;

/**
 * The one unit the magnitude floor applies to: a count of distinct members.
 *
 * Not `ratio` or `percent`. Reading the rule's headline — "any value that is a count of distinct
 * members (or is derived from one …) and is < 10" — as covering those makes a category error of it:
 * a stickiness of 0.2 is "less than 10", so the chart could never show a value, and a 5% share
 * would vanish while 45% stayed. §2.7 says what it actually means two lines further down —
 * "ratios derived from **suppressed counts**" — so a derived value is withheld when what it was
 * derived from was, which only the code that computed it knows. `stickiness` is null when MAU is
 * below the floor, and that decision is made in the analytics, not here.
 *
 * Nor `count`, `pence` or `minutes`: requests created per day and median response times are not
 * counts of people, and §2.7 exempts them explicitly.
 */
const MEMBER_UNITS = new Set(['members']);

const suppress = (value: Num): boolean => value !== null && value > 0 && value < SUPPRESSION_FLOOR;

const point = (entry: Point): Point =>
  suppress(entry.v) ? { t: entry.t, v: null, suppressed: true } : entry;

/**
 * Suppresses a whole chart, if its unit is a member count.
 *
 * Dispatched on `kind` rather than walked generically, because every shape hides its numbers
 * somewhere different and a generic walk would miss the ones that matter — a `Kpi`'s `previous`, a
 * sparkline point, a `Breakdown`'s `other`, a cohort cell. The spec is explicit that suppression
 * covers *every* member-derived number in a response and not just the headline.
 */
export const suppressChart = (chart: Chart): Chart => {
  switch (chart.kind) {
    // A KPI's headline is **not** subject to the magnitude floor. §2.7 suppresses "member KPIs when
    // the filtered population is < 10", which is the population floor and is applied once for the
    // whole response — a total of 80 members is not a disclosure because the daily average of it
    // happens to be 3. Its sparkline is a different matter: each point is a count of members in one
    // day, which is the same shape as a breakdown cell.
    case 'kpi':
      return MEMBER_UNITS.has(chart.unit) ? suppressSparkline(chart) : chart;
    case 'timeseries':
      return MEMBER_UNITS.has(chart.unit) ? suppressTimeSeries(chart) : chart;
    case 'breakdown':
      return MEMBER_UNITS.has(chart.unit) ? suppressBreakdown(chart) : chart;
    case 'matrix':
      return MEMBER_UNITS.has(chart.unit) ? suppressMatrix(chart) : chart;
    case 'map':
      return suppressMap(chart);
    case 'cohort':
      return {
        ...chart,
        cohorts: chart.cohorts.map(cohort =>
          suppress(cohort.size)
            ? { cohort: cohort.cohort, size: null, retention: cohort.retention.map(() => null) }
            : cohort,
        ),
      };
    case 'funnel':
      return {
        ...chart,
        steps: chart.steps.map(step =>
          suppress(step.value)
            ? { ...step, value: null, fromPrevious: null, fromStart: null }
            : step,
        ),
      };
    case 'group':
      return {
        ...chart,
        items: Object.fromEntries(
          Object.entries(chart.items).map(([id, item]) => [id, suppressChart(item)]),
        ),
      };
    default:
      return chart;
  }
};

/**
 * A KPI keeps its headline and loses the detail of its sparkline.
 *
 * The headline is an aggregate over the whole filtered population — which the population floor has
 * already judged. Each sparkline point is a single day's count of distinct members, which is a
 * handful of identifiable people and is named in §2.7 as something suppression covers.
 */
const suppressSparkline = (chart: KpiChart): KpiChart => ({
  ...chart,
  sparkline: chart.sparkline.map(point),
});

const suppressTimeSeries = (chart: TimeSeriesChart): TimeSeriesChart => ({
  ...chart,
  series: chart.series.map(series => ({
    ...series,
    points: series.points.map(point),
    ...(series.previous ? { previous: series.previous.map(point) } : {}),
  })),
});

/**
 * A breakdown, with the complementary rule.
 *
 * When exactly one cell is withheld and the total is shown, the hidden value is the total minus
 * everything else — so the next-smallest cell goes too. Without that, suppression is arithmetic
 * somebody can undo with a calculator, which is not suppression.
 */
const suppressBreakdown = (chart: BreakdownChart): BreakdownChart => {
  const hidden = new Set(chart.items.filter(item => suppress(item.value)).map(item => item.key));

  if (hidden.size === 1 && chart.total !== null) {
    const nextSmallest = chart.items
      .filter(item => !hidden.has(item.key) && item.value !== null)
      .sort((a, b) => (a.value ?? 0) - (b.value ?? 0))[0];

    if (nextSmallest) hidden.add(nextSmallest.key);
  }

  return {
    ...chart,
    items: chart.items.map(item =>
      hidden.has(item.key)
        ? { ...item, value: null, share: null, previous: undefined, suppressed: true as const }
        : item,
    ),
    other: suppress(chart.other ?? null) ? null : chart.other,
  };
};

const suppressMatrix = (chart: MatrixChart): MatrixChart => {
  const hidden: Array<[number, number]> = [];
  const cells = chart.cells.map((row, rowIndex) =>
    row.map((value, colIndex) => {
      if (!suppress(value)) return value;

      hidden.push([rowIndex, colIndex]);

      return null;
    }),
  );

  return { ...chart, cells, suppressed: hidden };
};

const suppressMap = (chart: MapChart): MapChart => ({
  ...chart,
  points: chart.points.map(entry =>
    suppress(entry.value) ? { ...entry, value: null, suppressed: true as const } : entry,
  ),
});

/**
 * When the filtered population itself is below ten, nothing in the response survives (§2.7).
 *
 * The population floor, which is the rule the per-value checks cannot express: with four people
 * selected, a chart of content they created is still a chart about four identifiable people, even
 * though "7 requests" is not a member count.
 */
export const suppressEverything = (charts: Record<string, Chart>): Record<string, Chart> =>
  Object.fromEntries(Object.entries(charts).map(([id, chart]) => [id, blank(chart)]));

const blank = (chart: Chart): Chart => {
  switch (chart.kind) {
    case 'kpi':
      return {
        ...chart,
        value: null,
        previous: null,
        changePct: null,
        sparkline: [],
        suppressed: true,
      };
    case 'timeseries':
      return {
        ...chart,
        series: chart.series.map(series => ({
          ...series,
          points: series.points.map(entry => ({ t: entry.t, v: null, suppressed: true as const })),
          ...(series.previous
            ? {
                previous: series.previous.map(entry => ({
                  t: entry.t,
                  v: null,
                  suppressed: true as const,
                })),
              }
            : {}),
        })),
      };
    case 'breakdown':
      return {
        ...chart,
        total: null,
        items: chart.items.map(item => ({
          ...item,
          value: null,
          share: null,
          previous: undefined,
          suppressed: true as const,
        })),
        other: chart.other === undefined ? undefined : null,
      };
    case 'matrix':
      return {
        ...chart,
        cells: chart.cells.map(row => row.map(() => null)),
        suppressed: chart.cells.flatMap((row, rowIndex) =>
          row.map((_, colIndex): [number, number] => [rowIndex, colIndex]),
        ),
      };
    case 'map':
      return {
        ...chart,
        points: chart.points.map(entry => ({ ...entry, value: null, suppressed: true as const })),
      };
    case 'cohort':
      return {
        ...chart,
        cohorts: chart.cohorts.map(cohort => ({
          cohort: cohort.cohort,
          size: null,
          retention: cohort.retention.map(() => null),
        })),
      };
    case 'funnel':
      return {
        ...chart,
        steps: chart.steps.map(step => ({
          ...step,
          value: null,
          fromPrevious: null,
          fromStart: null,
        })),
      };
    case 'gauge':
      return { ...chart, value: null, previous: null };
    case 'group':
      return {
        ...chart,
        items: Object.fromEntries(
          Object.entries(chart.items).map(([id, item]) => [id, blank(item)]),
        ),
      };
    default:
      return chart;
  }
};
