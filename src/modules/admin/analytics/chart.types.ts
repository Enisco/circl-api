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
}

export interface FunnelChart {
  kind: 'funnel';
  steps: Array<{ key: string; label: string; value: Num; fromPrevious: Num; fromStart: Num }>;
}

export interface CohortChart {
  kind: 'cohort';
  period: 'month';
  cohorts: Array<{ cohort: string; size: Num; retention: Num[] }>;
}

export interface TableChart<Row = Record<string, unknown>> {
  kind: 'table';
  columns: Array<{ key: string; label: string; unit?: Unit }>;
  rows: Row[];
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
