import { BreakdownChart, MatrixChart, Num } from './chart.types';

/** A counted group, as every breakdown query returns one. */
export interface CountedRow {
  key: string | null;
  label?: string | null;
  total: bigint | number;
}

export interface BreakdownOptions {
  /** How many groups to name before the rest become `other`. Omit to keep all of them. */
  top?: number;
  /** `code -> label`, where the labels come from a vocabulary rather than the row. */
  labels?: Map<string, string>;
  /** What to call a row whose key is null. Every "not set" is a real group, not a gap. */
  unknownLabel?: string;
  /** Fixed order, for the vocabularies that have one — journey stages, age bands. */
  order?: string[];
  /**
   * The denominator, where it is not the sum of the groups.
   *
   * Interests and languages are multi-valued: a member with four of them is counted in four
   * groups, so the shares would sum to 400% against their own total. The share that means
   * something is "this fraction of members hold this code", so the denominator is the member count.
   */
  total?: number;
  unit?: BreakdownChart['unit'];
  /**
   * Whether the values can meaningfully be added together. Default true.
   *
   * False for a breakdown of a **measure** rather than a count — a median response time per
   * profession, say. Summing medians gives a number that means nothing, and dividing by it gives a
   * "share" of minutes: "Finance & Accounting: 280 minutes, 32% of the total" invites a reader to
   * conclude that finance takes up a third of everybody's waiting, which is not a statement the
   * data supports. With this false the chart reports no total and no shares, and the bars are read
   * against each other as the magnitudes they are.
   */
  additive?: boolean;
}

const UNKNOWN_KEY = 'UNKNOWN';

/**
 * Rows into a breakdown.
 *
 * Here rather than in each tab because the fiddly parts are the same every time and are all places
 * to be subtly wrong: a null key is a group and not a gap, the shares have to be over the right
 * denominator, `other` must be the sum of what was dropped rather than the remainder of a rounded
 * total, and a vocabulary with an order has to keep it even where a value has no members.
 */
export const toBreakdown = (rows: CountedRow[], options: BreakdownOptions = {}): BreakdownChart => {
  const counts = new Map<string, number>();

  for (const row of rows) {
    const key = row.key ?? UNKNOWN_KEY;

    counts.set(key, (counts.get(key) ?? 0) + Number(row.total));
  }

  const bySize = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);

  // Which groups get named is always decided by **size**, even when a vocabulary supplies an
  // order: `other` has to be the small groups, or it is a bucket holding whatever happened to be
  // late in the list. The order is then applied to the ones that survived.
  const named = options.top ? bySize.slice(0, options.top) : bySize;
  const dropped = options.top ? bySize.slice(options.top) : [];

  // A vocabulary's own order, with the values it defines kept even at zero: a journey stage nobody
  // has selected is information, and a bar chart that silently drops it reads as though the stage
  // does not exist. Anything the vocabulary does not know about follows, largest first, so the
  // order is deterministic rather than whatever the query returned.
  const ordered = options.order
    ? [
        ...options.order.filter(key => !options.top || named.includes(key)),
        ...named.filter(key => !options.order!.includes(key)),
      ]
    : named;

  const additive = options.additive !== false;
  const sum = [...counts.values()].reduce((running, value) => running + value, 0);
  const total = additive ? (options.total ?? sum) : null;
  const other = dropped.reduce((running, key) => running + (counts.get(key) ?? 0), 0);

  // `other` is omitted where the denominator was overridden, which is the multi-valued case.
  // A member holding four interests is counted in four groups, so a sum of the dropped groups is
  // not a quantity comparable to a member count — it can exceed the total outright, and a bar
  // reading "other: 120 of 80 members" is worse than no bar.
  const comparable = options.total === undefined;

  return {
    kind: 'breakdown',
    unit: options.unit ?? 'members',
    total,
    items: ordered.map(key => {
      const value = counts.get(key) ?? 0;

      return {
        key,
        label: labelFor(key, options),
        value,
        share: total !== null && total > 0 ? Math.round((value / total) * 10_000) / 10_000 : null,
      };
    }),
    ...(dropped.length && comparable && additive ? { other } : {}),
  };
};

const labelFor = (key: string, options: BreakdownOptions): string => {
  if (key === UNKNOWN_KEY) return options.unknownLabel ?? 'Not set';

  return options.labels?.get(key) ?? titleise(key);
};

/** `WEST_AFRICAN` → `West african`. Only ever a fallback: a real label comes from the vocabulary. */
export const titleise = (code: string): string =>
  code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, ' ');

export interface MatrixOptions {
  rows: Array<{ key: string; label: string }>;
  cols: Array<{ key: string; label: string }>;
  unit?: MatrixChart['unit'];
}

/** `(row, col, count)` rows into a matrix, with every declared cell present even at zero. */
export const toMatrix = (
  rows: Array<{ row: string | null; col: string | null; total: bigint | number }>,
  options: MatrixOptions,
): MatrixChart => {
  const byCell = new Map<string, number>();

  for (const entry of rows) {
    const cell = `${entry.row ?? UNKNOWN_KEY}|${entry.col ?? UNKNOWN_KEY}`;

    byCell.set(cell, (byCell.get(cell) ?? 0) + Number(entry.total));
  }

  return {
    kind: 'matrix',
    unit: options.unit ?? 'members',
    rows: options.rows,
    cols: options.cols,
    cells: options.rows.map(row =>
      options.cols.map((col): Num => byCell.get(`${row.key}|${col.key}`) ?? 0),
    ),
    suppressed: [],
  };
};
