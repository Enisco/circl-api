import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { shiftDateOnly } from '@/common';
import {
  BreakdownChart,
  Chart,
  KpiChart,
  MapChart,
  Num,
  Point,
  TimeSeriesChart,
} from './chart.types';
import { Bucket, bucketsFor, indexByDay } from './buckets';
import { AnalyticsRunnerService } from './analytics-runner.service';
import { SUPPRESSION_FLOOR } from './suppression';
import { ResolvedMemberFilter, ResolvedRange } from '../filters/member-filter.builder';

/** `ActivitySubject` → the product section the portal stacks it under (§5.25 Overview). */
const SECTION_OF: Record<string, string> = {
  REQUEST: 'COMMUNITY',
  OFFER: 'COMMUNITY',
  UPDATE: 'COMMUNITY',
  GUIDE: 'COMMUNITY',
  GROUP: 'COMMUNITY',
  PROFESSIONAL_LISTING: 'PROFESSIONALS',
  CONNECT_PROFILE: 'CONNECT',
  STORE: 'COMMERCE',
  STORE_ITEM: 'COMMERCE',
};

const SECTIONS = ['COMMUNITY', 'PROFESSIONALS', 'CONNECT', 'COMMERCE'] as const;

/** `SearchScope` → section, for the `SEARCH_TERM` subject, which carries its scope separately. */
const SECTION_OF_SCOPE: Record<string, string> = {
  COMMUNITY: 'COMMUNITY',
  PROFESSIONALS: 'PROFESSIONALS',
  CONNECT: 'CONNECT',
  COMMERCE: 'COMMERCE',
};

/**
 * The Overview tab (§5.25), and the four charts the dashboard borrows from it.
 *
 * Every query starts from the same `pop` CTE — the filtered population, out of
 * `mv_member_dimensions` — so a chart cannot disagree with the member list about who is being
 * counted. That is the whole reason the view and `MemberFilterBuilder`'s third output exist: before
 * them, "members in Leeds" was spelled out once per chart.
 */
@Injectable()
export class OverviewAnalytics {
  constructor(private readonly runner: AnalyticsRunnerService) {}

  /** Every chart of the tab, as thunks — the runner decides which to compute and caches each. */
  charts(filter: ResolvedMemberFilter, range: ResolvedRange): Record<string, () => Promise<Chart>> {
    return {
      kpis: () => this.kpis(filter, range),
      signups: () => this.signups(filter, range),
      activeMembers: () => this.activeMembers(filter, range),
      activityBySection: () => this.activityBySection(filter, range),
      topCities: () => this.topCities(filter, range),
      cityMap: () => this.cityMap(filter, range),
    };
  }

  /** The population, as a CTE every other query in this file joins to. */
  private pop(filter: ResolvedMemberFilter): Prisma.Sql {
    return Prisma.sql`
      pop AS (
        SELECT m."user_id", m."created_day", m."city_id"
        FROM "mv_member_dimensions" m
        WHERE ${filter.viewSql}
      )`;
  }

  /**
   * The five headline numbers.
   *
   * `totalMembers` is "as of `to`", not "right now": a dashboard showing last month's range beside
   * today's member count is two different questions on one row. Counted as members who had signed
   * up by the end of the range, which the view's `created_day` answers directly.
   *
   * `stickiness` is DAU ÷ MAU, the proportion of a month's members who turn up on an average day.
   * Reported as a ratio rather than a percentage because that is how everybody quotes it.
   */
  private async kpis(filter: ResolvedMemberFilter, range: ResolvedRange): Promise<Chart> {
    const previous = range.previous;
    const [current, prior] = await Promise.all([
      this.kpiNumbers(filter, range.from, range.to),
      previous ? this.kpiNumbers(filter, previous.from, previous.to) : null,
    ]);

    const sparkline = await this.dailySignups(filter, range);

    const card = (
      value: Num,
      was: Num,
      unit: KpiChart['unit'],
      points: Point[] = [],
    ): KpiChart => ({
      kind: 'kpi',
      value,
      previous: was,
      changePct: changeOf(value, was),
      unit,
      sparkline: points,
    });

    return {
      kind: 'group',
      items: {
        totalMembers: card(current.totalMembers, prior?.totalMembers ?? null, 'members'),
        newSignups: card(current.newSignups, prior?.newSignups ?? null, 'members', sparkline),
        dau: card(current.dau, prior?.dau ?? null, 'members'),
        mau: card(current.mau, prior?.mau ?? null, 'members'),
        stickiness: card(current.stickiness, prior?.stickiness ?? null, 'ratio'),
      },
    };
  }

  private async kpiNumbers(
    filter: ResolvedMemberFilter,
    from: string,
    to: string,
  ): Promise<{
    totalMembers: number;
    newSignups: number;
    dau: number;
    mau: number;
    stickiness: number | null;
  }> {
    const days = Math.max(1, daysBetween(from, to));
    const monthStart = shiftDateOnly(to, -29);

    const [row] = await this.runner.query(
      tx => tx.$queryRaw<
        Array<{
          total_members: bigint;
          new_signups: bigint;
          active_days: bigint;
          mau: bigint;
        }>
      >`
        WITH ${this.pop(filter)}
        SELECT
          (SELECT COUNT(*) FROM pop WHERE "created_day" <= ${to}::date) AS total_members,
          (SELECT COUNT(*) FROM pop
            WHERE "created_day" >= ${from}::date AND "created_day" <= ${to}::date) AS new_signups,
          -- Member-days, not members: divided by the range length below, this is the average number
          -- of members active on a day. Counting distinct members instead would answer "how many
          -- people turned up at all", which is WAU/MAU's question.
          (SELECT COUNT(*) FROM "user_daily_activity" a JOIN pop ON pop."user_id" = a."user_id"
            WHERE a."day" >= ${from}::date AND a."day" <= ${to}::date) AS active_days,
          (SELECT COUNT(DISTINCT a."user_id") FROM "user_daily_activity" a
            JOIN pop ON pop."user_id" = a."user_id"
            WHERE a."day" >= ${monthStart}::date AND a."day" <= ${to}::date) AS mau
      `,
    );

    const dau = Number(row?.active_days ?? 0) / days;
    const mau = Number(row?.mau ?? 0);

    return {
      totalMembers: Number(row?.total_members ?? 0),
      newSignups: Number(row?.new_signups ?? 0),
      dau: Math.round(dau * 10) / 10,
      mau,
      // Null where there is nothing to divide by, and null where the denominator is small enough
      // to be a disclosure. §2.7 suppresses "ratios derived from suppressed counts (e.g. stickiness
      // = dau ÷ mau)" — which only this function knows, because by the time the suppressor sees a
      // stickiness of 0.2 the MAU it came from is gone. A stickiness of 0 would also read as
      // "nobody comes back", which is a different statement from "nobody came at all".
      stickiness: mau >= SUPPRESSION_FLOOR ? Math.round((dau / mau) * 1000) / 1000 : null,
    };
  }

  /** Sign-ups per bucket. */
  private async signups(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
  ): Promise<TimeSeriesChart> {
    const points = await this.signupSeries(filter, range.from, range.to, range.granularity);
    const previous = range.previous
      ? await this.signupSeries(filter, range.previous.from, range.previous.to, range.granularity)
      : undefined;

    return {
      kind: 'timeseries',
      granularity: range.granularity,
      unit: 'members',
      series: [{ key: 'signups', label: 'Sign-ups', points, ...(previous ? { previous } : {}) }],
    };
  }

  private async signupSeries(
    filter: ResolvedMemberFilter,
    from: string,
    to: string,
    granularity: ResolvedRange['granularity'],
  ): Promise<Point[]> {
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ day: Date; total: bigint }>>`
        WITH ${this.pop(filter)}
        SELECT "created_day" AS day, COUNT(*) AS total
        FROM pop
        WHERE "created_day" >= ${from}::date AND "created_day" <= ${to}::date
        GROUP BY 1
      `,
    );

    return intoBuckets(bucketsFor(from, to, granularity), rows);
  }

  /** The sparkline under `newSignups`: always daily, whatever the tab's granularity. */
  private async dailySignups(filter: ResolvedMemberFilter, range: ResolvedRange): Promise<Point[]> {
    return this.signupSeries(filter, range.from, range.to, 'day');
  }

  /**
   * Distinct members active per bucket.
   *
   * Its own chart rather than a second series beside sign-ups. The two measures differ by a factor
   * of about fifty, so on one axis the smaller is a flat line along the bottom — and the portal
   * never draws dual axes, which is the right call: a reader cannot tell which line belongs to
   * which scale without checking, and usually does not.
   */
  private async activeMembers(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
  ): Promise<TimeSeriesChart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);
    const points = await this.activeSeries(filter, buckets);
    const previous = range.previous
      ? await this.activeSeries(
          filter,
          bucketsFor(range.previous.from, range.previous.to, range.granularity),
        )
      : undefined;

    return {
      kind: 'timeseries',
      granularity: range.granularity,
      unit: 'members',
      series: [
        {
          key: 'activeMembers',
          label: 'Active members',
          points,
          ...(previous ? { previous } : {}),
        },
      ],
    };
  }

  /**
   * One query per bucket's worth of distinct members, done as a single grouped query.
   *
   * `DISTINCT` has to be per bucket, not per day then summed: somebody active on three days of a
   * week is one active member that week, and summing days would count them three times. So the
   * bucket boundaries go into the query as a join rather than being applied afterwards.
   */
  private async activeSeries(filter: ResolvedMemberFilter, buckets: Bucket[]): Promise<Point[]> {
    if (!buckets.length) return [];

    const bounds = Prisma.join(
      buckets.map(
        (bucket, index) =>
          Prisma.sql`(${index}::int, ${bucket.key}::date, ${bucket.lastDay}::date)`,
      ),
      ', ',
    );

    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ position: number; total: bigint }>>`
        WITH ${this.pop(filter)},
        buckets (position, starts, ends) AS (VALUES ${bounds}),
        -- The population's activity, narrowed once rather than per bucket.
        acted AS (
          SELECT a."user_id", a."day"
          FROM "user_daily_activity" a
          JOIN pop ON pop."user_id" = a."user_id"
        )
        SELECT b.position AS position, COUNT(DISTINCT acted."user_id") AS total
        FROM buckets b
        -- LEFT, so a bucket nobody was active in is a zero rather than a missing row.
        LEFT JOIN acted ON acted."day" >= b.starts AND acted."day" <= b.ends
        GROUP BY 1
      `,
    );

    const byPosition = new Map(rows.map(row => [Number(row.position), Number(row.total)]));

    return buckets.map((bucket, position) => ({
      t: bucket.key,
      v: byPosition.get(position) ?? 0,
    }));
  }

  /**
   * What members did, stacked by section.
   *
   * Counted from `activity_events`, which is deliberately the *event* count and not the actor
   * count: the question the stack answers is "where is the platform being used", and one member
   * doing twenty things in Commerce is twenty things in Commerce.
   */
  private async activityBySection(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
  ): Promise<TimeSeriesChart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);
    const rows = await this.runner.query(
      tx => tx.$queryRaw<
        Array<{ day: Date; subject: string; scope: string | null; total: bigint }>
      >`
        WITH ${this.pop(filter)}
        SELECT (e."occurred_at" AT TIME ZONE 'Europe/London')::date AS day,
               e."subject"::text AS subject,
               e."scope"::text AS scope,
               COUNT(*) AS total
        FROM "activity_events" e
        JOIN pop ON pop."user_id" = e."user_id"
        WHERE e."occurred_at" >= ${range.fromInstant} AND e."occurred_at" < ${range.toInstant}
        GROUP BY 1, 2, 3
      `,
    );

    const index = indexByDay(buckets);
    const totals = new Map<string, number[]>(
      SECTIONS.map(section => [section, buckets.map(() => 0)]),
    );

    for (const row of rows) {
      const section =
        row.subject === 'SEARCH_TERM' ? SECTION_OF_SCOPE[row.scope ?? ''] : SECTION_OF[row.subject];

      if (!section) continue;

      const position = index.get(dayKey(row.day));

      if (position === undefined) continue;

      totals.get(section)![position] += Number(row.total);
    }

    return {
      kind: 'timeseries',
      granularity: range.granularity,
      unit: 'count',
      series: SECTIONS.map(section => ({
        key: section,
        label: titleCase(section),
        points: buckets.map((bucket, position) => ({
          t: bucket.key,
          v: totals.get(section)![position],
        })),
      })),
    };
  }

  /** The ten cities with the most members, as of `to`. */
  private async topCities(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
  ): Promise<BreakdownChart> {
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ city_id: string | null; name: string | null; total: bigint }>>`
        WITH ${this.pop(filter)}
        SELECT pop."city_id" AS city_id, c."name" AS name, COUNT(*) AS total
        FROM pop
        LEFT JOIN "cities" c ON c."id" = pop."city_id"
        WHERE pop."created_day" <= ${range.to}::date
        GROUP BY 1, 2
        ORDER BY total DESC
      `,
    );

    const total = rows.reduce((sum, row) => sum + Number(row.total), 0);
    const top = rows.slice(0, 10);
    const rest = rows.slice(10).reduce((sum, row) => sum + Number(row.total), 0);

    return {
      kind: 'breakdown',
      unit: 'members',
      total,
      items: top.map(row => ({
        // A member with no city is a real category, not a gap: they signed up before the question
        // was asked, or skipped it.
        key: row.city_id ?? 'UNKNOWN',
        label: row.name ?? 'Not set',
        value: Number(row.total),
        share: total > 0 ? Number(row.total) / total : null,
      })),
      ...(rest > 0 ? { other: rest } : {}),
    };
  }

  /**
   * The same counts on a map, for the cities that have coordinates.
   *
   * "As of `to`", exactly as `topCities` is. Without that cut-off the map counted every member and
   * the breakdown counted those who had signed up by the end of the range — two numbers for London
   * on one page, differing by however many joined since.
   */
  private async cityMap(filter: ResolvedMemberFilter, range: ResolvedRange): Promise<MapChart> {
    const rows = await this.runner.query(
      tx => tx.$queryRaw<
        Array<{ city_id: string; name: string; lat: number; lng: number; total: bigint }>
      >`
        WITH ${this.pop(filter)}
        SELECT c."id" AS city_id, c."name" AS name,
               c."latitude" AS lat, c."longitude" AS lng, COUNT(*) AS total
        FROM pop
        JOIN "cities" c ON c."id" = pop."city_id"
        WHERE c."latitude" IS NOT NULL AND c."longitude" IS NOT NULL
          AND pop."created_day" <= ${range.to}::date
        GROUP BY 1, 2, 3, 4
      `,
    );

    return {
      kind: 'map',
      points: rows.map(row => ({
        cityId: row.city_id,
        name: row.name,
        lat: row.lat,
        lng: row.lng,
        value: Number(row.total),
      })),
    };
  }
}

/** Rows grouped by London day, laid onto buckets. */
const intoBuckets = (buckets: Bucket[], rows: Array<{ day: Date; total: bigint }>): Point[] => {
  const index = indexByDay(buckets);
  const totals = buckets.map(() => 0);

  for (const row of rows) {
    const position = index.get(dayKey(row.day));

    if (position !== undefined) totals[position] += Number(row.total);
  }

  return buckets.map((bucket, position) => ({ t: bucket.key, v: totals[position] }));
};

/**
 * A `date` column back to `YYYY-MM-DD`.
 *
 * Postgres `date` arrives as a `Date` at UTC midnight, so slicing the ISO string is exact — and
 * unlike any local-time formatting, it cannot shift the day.
 */
const dayKey = (day: Date): string => day.toISOString().slice(0, 10);

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/** Percentage change, or null where there is nothing to compare against. */
const changeOf = (value: Num, previous: Num): Num => {
  if (value === null || previous === null || previous === 0) return null;

  return Math.round(((value - previous) / previous) * 1000) / 10;
};

const titleCase = (value: string): string =>
  value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');
