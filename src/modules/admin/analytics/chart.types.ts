/**
 * The chart shapes (§5.25).
 *
 * Nine of them, and no tenth: the portal draws one component per `kind`, so an endpoint that
 * invents a shape produces a chart nothing can render. `Num` is `number | null` throughout because
 * **any** member-derived number can be suppressed (§2.7), and a suppressed value has to be absent
 * rather than zero — zero means "nobody", null means "fewer than ten, and we are not saying".
 */
export type Num = number | null;

export type Unit = 'count' | 'members' | 'pence' | 'minutes' | 'percent' | 'ratio';

export type Granularity = 'day' | 'week' | 'month';

export interface Point {
  /** Bucket start, as a London `YYYY-MM-DD`. */
  t: string;
  v: Num;
  suppressed?: true;
}

export interface Series {
  key: string;
  label: string;
  points: Point[];
  /** The comparison period, aligned by index rather than by date — the periods differ in length. */
  previous?: Point[];
}

export interface TimeSeriesChart {
  kind: 'timeseries';
  granularity: Granularity;
  unit: Unit;
  series: Series[];
}

export interface KpiChart {
  kind: 'kpi';
  value: Num;
  previous: Num;
  changePct: Num;
  unit: Unit;
  sparkline: Point[];
  suppressed?: true;
}

export interface BreakdownItem {
  key: string;
  label: string;
  value: Num;
  share: Num;
  suppressed?: true;
  previous?: Num;
}

export interface BreakdownChart {
  kind: 'breakdown';
  unit: Unit;
  total: Num;
  items: BreakdownItem[];
  /** Everything outside the top N, as one number. */
  other?: Num;
}

export interface MatrixChart {
  kind: 'matrix';
  unit: Unit;
  rows: Array<{ key: string; label: string }>;
  cols: Array<{ key: string; label: string }>;
  cells: Num[][];
  /** `[row, col]` pairs whose value was withheld, so the portal can shade them. */
  suppressed: Array<[number, number]>;
  /**
   * The period the values actually cover, when it is not the one the caller asked for.
   *
   * `demandGaps` reads scores a nightly job computed over its own window, so the date picker above
   * it does not control them. Without saying so, a staff member who narrows the range to last week
   * and sees the numbers stay put concludes the chart is broken — or worse, does not notice and
   * reads a month-old signal as last week's.
   */
  window?: { from: string; to: string; computedAt: string };
}

export interface FunnelChart {
  kind: 'funnel';
  /**
   * What the steps count.
   *
   * Carried for the same reason every other shape carries it: the suppressor applies the
   * small-number floor only to counts of **members**. Without it, a funnel of deal stages had the
   * member floor applied to counts of deals and came back with holes in the middle.
   */
  unit: Unit;
  steps: Array<{ key: string; label: string; value: Num; fromPrevious: Num; fromStart: Num }>;
}

export interface CohortChart {
  kind: 'cohort';
  period: 'month';
  cohorts: Array<{ cohort: string; size: Num; retention: Num[] }>;
}

export interface TableChart<Row = Record<string, unknown>> {
  kind: 'table';
  /**
   * A column's `unit` is what lets the suppressor find the member counts in a table.
   *
   * Every other shape declares one unit for the whole chart; a table's columns each have their
   * own, so the unit has to live here. A column of member counts left without it is a column the
   * floor cannot see — which is how `topGuides` shipped showing "read by 3 members".
   */
  columns: Array<{ key: string; label: string; unit?: Unit }>;
  rows: Row[];
  /** Set when the rows were withheld rather than absent, so an empty table can say which it is. */
  suppressed?: true;
}

export interface MapChart {
  kind: 'map';
  points: Array<{
    cityId: string;
    name: string;
    lat: number;
    lng: number;
    value: Num;
    suppressed?: true;
  }>;
}

export interface GaugeChart {
  kind: 'gauge';
  value: Num;
  previous: Num;
  unit: 'percent';
}

export interface GroupChart {
  kind: 'group';
  items: Record<string, Chart>;
}

/**
 * A chart that could not be computed.
 *
 * In the payload rather than as a response status, because one failed chart must not fail a tab of
 * twelve (§8.4). A dashboard that goes blank because a single query timed out is a dashboard
 * nobody trusts; one that shows eleven charts and says what happened to the twelfth is usable.
 */
export interface ErrorChart {
  kind: 'error';
  code: string;
  message?: string;
}

export type Chart =
  | TimeSeriesChart
  | KpiChart
  | BreakdownChart
  | MatrixChart
  | FunnelChart
  | CohortChart
  | TableChart
  | MapChart
  | GaugeChart
  | GroupChart
  | ErrorChart;

export interface AnalyticsResponse {
  range: {
    from: string;
    to: string;
    previousFrom?: string;
    previousTo?: string;
    granularity: Granularity;
    timezone: 'Europe/London';
  };
  generatedAt: string;
  charts: Record<string, Chart>;
}
