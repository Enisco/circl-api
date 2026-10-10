import { Granularity } from './chart.types';
import { dateOnlySpan, londonMidnight, shiftDateOnly } from '@/common';

/** One bucket of a series: the label the portal shows, and the half-open instant range behind it. */
export interface Bucket {
  /** London `YYYY-MM-DD` of the bucket's first day, which is the point's `t`. */
  key: string;
  from: Date;
  /** Exclusive. */
  to: Date;
  /** The last London day inside the bucket, for the "as of" measures (WAU, MAU, cumulative). */
  lastDay: string;
}

/**
 * The buckets of a range, at a granularity.
 *
 * Built from calendar dates rather than by adding milliseconds, because a London day is 23 hours
 * long once a year and 25 hours long once a year — and a series built by adding 86,400,000 drifts
 * an hour each way, which eventually files a day in the wrong bucket.
 *
 * Weeks start Monday (§2.5). A range that begins mid-week gets a short first bucket rather than a
 * bucket reaching back before `from`: a chart must not show activity from outside the range it says
 * it covers.
 */
export const bucketsFor = (from: string, to: string, granularity: Granularity): Bucket[] => {
  const buckets: Bucket[] = [];
  let cursor = from;

  while (cursor <= to) {
    const end = endOfBucket(cursor, granularity);
    const lastDay = end < to ? end : to;

    buckets.push({
      key: cursor,
      from: londonMidnight(cursor),
      to: londonMidnight(shiftDateOnly(lastDay, 1)),
      lastDay,
    });

    cursor = shiftDateOnly(lastDay, 1);
  }

  return buckets;
};

/** The last day of the bucket that `day` falls in. */
const endOfBucket = (day: string, granularity: Granularity): string => {
  if (granularity === 'day') return day;

  if (granularity === 'week') {
    // `getUTCDay()` is 0 for Sunday; Monday-based weeks want Sunday to be the seventh day.
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    const monday = weekday === 0 ? 6 : weekday - 1;

    return shiftDateOnly(day, 6 - monday);
  }

  const [year, month] = day.split('-').map(Number);
  // Day 0 of the next month is the last day of this one, which is how February is handled without
  // anybody writing down how long February is.
  const lastOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return `${day.slice(0, 7)}-${String(lastOfMonth).padStart(2, '0')}`;
};

/**
 * The bucket each row belongs to, by its London day.
 *
 * Rows come back from SQL already grouped by day; mapping them onto buckets here rather than in SQL
 * means one query serves all three granularities, and the bucket boundaries are the ones the series
 * was built with rather than Postgres's idea of a week.
 */
export const indexByDay = (buckets: Bucket[]): Map<string, number> => {
  const index = new Map<string, number>();

  buckets.forEach((bucket, position) => {
    let day = bucket.key;

    while (day <= bucket.lastDay) {
      index.set(day, position);
      day = shiftDateOnly(day, 1);
    }
  });

  return index;
};

/** How many whole days a range covers, inclusive of both ends. */
export const rangeDays = dateOnlySpan;
