import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { shiftDateOnly } from '@/common';
import { AnalyticsRunnerService } from './analytics-runner.service';
import {
  BreakdownChart,
  Chart,
  CohortChart,
  FunnelChart,
  Num,
  Point,
  TimeSeriesChart,
} from './chart.types';
import { Bucket, bucketsFor, indexByDay } from './buckets';
import { toBreakdown } from './breakdown';
import { SUPPRESSION_FLOOR } from './suppression';
import {
  MemberFilterInput,
  ResolvedMemberFilter,
  ResolvedRange,
} from '../filters/member-filter.builder';

/** How far back the cohort grid goes. Eighteen months is six quarters, which is how it is read. */
const COHORT_MONTHS = 18;

/** The Dn offsets the spec asks for. */
const DN_OFFSETS = [1, 7, 30] as const;

/** How many app versions get their own band before the rest become `OTHER`. */
const TOP_VERSIONS = 6;

const FUNNEL_STEPS = [
  { key: 'registered', label: 'Registered', column: null },
  { key: 'profile', label: 'Profile completed', column: 'profile_completed_at' },
  { key: 'arrival', label: 'Arrival set', column: 'arrival_set_at' },
  { key: 'interests', label: 'Interests chosen', column: 'interests_set_at' },
  { key: 'firstAction', label: 'First action', column: 'first_action_at' },
] as const;

/**
 * Growth & Retention (§5.25).
 *
 * The tab that answers "is this working". Three of its charts are the only ones in the portal that
 * cannot be read off a single table — retention cohorts, Dn retention and the new/returning split
 * all need each member's sign-up day held against every day they were active — so they run live
 * against `user_daily_activity` joined to the population, which §8.3 confirms is the right place
 * for them: one row per member-day is cheap, and a rollup of a retention grid cannot be
 * recalculated when somebody changes the cohort window.
 */
@Injectable()
export class GrowthAnalytics {
  constructor(private readonly runner: AnalyticsRunnerService) {}

  charts(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    input: MemberFilterInput,
  ): Record<string, () => Promise<Chart>> {
    return {
      signups: () => this.signups(filter, range),
      cumulativeMembers: () => this.cumulativeMembers(filter, range, input),
      activeMembers: () => this.activeMembers(filter, range),
      stickiness: () => this.stickiness(filter, range),
      retentionCohorts: () => this.retentionCohorts(filter, range),
      retentionDn: () => this.retentionDn(filter, range),
      onboardingFunnel: () => this.onboardingFunnel(filter, range),
      signupMethods: () => this.signupMethods(filter, range),
      platforms: () => this.platforms(filter, range),
      appVersionAdoption: () => this.appVersionAdoption(filter, range),
      newReturningReactivated: () => this.newReturningReactivated(filter, range),
    };
  }

  private pop(filter: ResolvedMemberFilter): Prisma.Sql {
    return Prisma.sql`
      pop AS (
        SELECT m."user_id", m."created_day", m."signup_method", m."platform", m."app_version"
        FROM "mv_member_dimensions" m
        WHERE ${filter.viewSql}
      )`;
  }

  // ─── Sign-ups and membership ───────────────────────────────────────────────

  private async signups(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
  ): Promise<TimeSeriesChart> {
    const points = await this.signupsIn(filter, range.from, range.to, range.granularity);
    const previous = range.previous
      ? await this.signupsIn(filter, range.previous.from, range.previous.to, range.granularity)
      : undefined;

    return {
      kind: 'timeseries',
      granularity: range.granularity,
      unit: 'members',
      series: [{ key: 'signups', label: 'Sign-ups', points, ...(previous ? { previous } : {}) }],
    };
  }

  private async signupsIn(
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

    return layOnBuckets(bucketsFor(from, to, granularity), rows);
  }

  /**
   * How many members there were on each day, not how many have ever joined.
   *
   * Two different sums, because the view cannot answer the question on its own. `mv_member_dimensions`
   * holds **today's** members, so accumulating it gives "the people who are members now, by when
   * they joined" — a curve that quietly rewrites history every time somebody deletes their account.
   *
   * Unfiltered, the honest curve is sign-ups including the accounts since anonymised, minus the
   * anonymisations as they happened — so it runs off `users` directly. Filtered, it runs off the
   * population: an anonymised account has no city, no gender and no journey stage left, so it
   * cannot belong to a filtered set, and there is nothing to subtract. (The first version subtracted
   * anonymisations from a view that had already excluded them, which counted every departure twice
   * and could drive the line below zero.)
   */
  private async cumulativeMembers(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    input: MemberFilterInput,
  ): Promise<TimeSeriesChart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);
    const counts = hasMemberFilters(input)
      ? await this.filteredMembership(filter, range)
      : await this.wholeMembership(range);

    const joined = layOnBuckets(buckets, counts.joined).map(point => point.v ?? 0);
    const left = layOnBuckets(buckets, counts.left).map(point => point.v ?? 0);

    let running = counts.before;
    const points: Point[] = buckets.map((bucket, position) => {
      running += joined[position] - left[position];

      return { t: bucket.key, v: running };
    });

    return {
      kind: 'timeseries',
      granularity: range.granularity,
      unit: 'members',
      series: [{ key: 'cumulativeMembers', label: 'Members', points }],
    };
  }

  /** Everybody who was ever a member, and when each of them left. */
  private async wholeMembership(range: ResolvedRange): Promise<MembershipCounts> {
    const [[opening], joined, left] = await Promise.all([
      this.runner.query(
        tx => tx.$queryRaw<Array<{ total: bigint }>>`
          SELECT COUNT(*) AS total
          FROM "users"
          WHERE "is_staff" = false AND "deleted_at" IS NULL
            AND ("created_at" AT TIME ZONE 'Europe/London')::date < ${range.from}::date
            AND (
              "anonymised_at" IS NULL
              OR ("anonymised_at" AT TIME ZONE 'Europe/London')::date >= ${range.from}::date
            )
        `,
      ),
      this.runner.query(
        tx => tx.$queryRaw<Array<{ day: Date; total: bigint }>>`
          SELECT ("created_at" AT TIME ZONE 'Europe/London')::date AS day, COUNT(*) AS total
          FROM "users"
          WHERE "is_staff" = false AND "deleted_at" IS NULL
            AND ("created_at" AT TIME ZONE 'Europe/London')::date >= ${range.from}::date
            AND ("created_at" AT TIME ZONE 'Europe/London')::date <= ${range.to}::date
          GROUP BY 1
        `,
      ),
      this.runner.query(
        tx => tx.$queryRaw<Array<{ day: Date; total: bigint }>>`
          SELECT ("anonymised_at" AT TIME ZONE 'Europe/London')::date AS day, COUNT(*) AS total
          FROM "users"
          -- The deleted_at condition is here too, and it is the whole correctness of this chart:
          -- the opening balance and the joins both exclude soft-deleted rows, so counting their
          -- departures would subtract people who were never added. Unbalanced, the line fell
          -- below zero.
          WHERE "is_staff" = false AND "deleted_at" IS NULL
            AND "anonymised_at" IS NOT NULL
            AND ("anonymised_at" AT TIME ZONE 'Europe/London')::date >= ${range.from}::date
            AND ("anonymised_at" AT TIME ZONE 'Europe/London')::date <= ${range.to}::date
          GROUP BY 1
        `,
      ),
    ]);

    return { before: Number(opening?.total ?? 0), joined, left };
  }

  /** The filtered population accumulating. Nothing leaves it, because nothing in it can. */
  private async filteredMembership(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
  ): Promise<MembershipCounts> {
    const [[opening], joined] = await Promise.all([
      this.runner.query(
        tx => tx.$queryRaw<Array<{ total: bigint }>>`
          WITH ${this.pop(filter)}
          SELECT COUNT(*) AS total FROM pop WHERE "created_day" < ${range.from}::date
        `,
      ),
      this.runner.query(
        tx => tx.$queryRaw<Array<{ day: Date; total: bigint }>>`
          WITH ${this.pop(filter)}
          SELECT "created_day" AS day, COUNT(*) AS total
          FROM pop
          WHERE "created_day" >= ${range.from}::date AND "created_day" <= ${range.to}::date
          GROUP BY 1
        `,
      ),
    ]);

    return { before: Number(opening?.total ?? 0), joined, left: [] };
  }

  // ─── Activity ──────────────────────────────────────────────────────────────

  /**
   * DAU, WAU and MAU, each **as of** the last day of the bucket.
   *
   * Not "distinct actives within the bucket", which is what Overview's single series shows. A WAU
   * is by definition a seven-day window, so on a monthly chart it is the seven days ending that
   * month — not the month. Reading one as the other makes WAU and MAU converge on long buckets and
   * the chart stops saying anything.
   */
  private async activeMembers(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
  ): Promise<TimeSeriesChart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);
    const windows = await this.activeWindows(filter, buckets);

    return {
      kind: 'timeseries',
      granularity: range.granularity,
      unit: 'members',
      series: [
        { key: 'dau', label: 'Daily', points: windows.map(w => ({ t: w.t, v: w.dau })) },
        { key: 'wau', label: 'Weekly', points: windows.map(w => ({ t: w.t, v: w.wau })) },
        { key: 'mau', label: 'Monthly', points: windows.map(w => ({ t: w.t, v: w.mau })) },
      ],
    };
  }

  /** One query for all three windows of every bucket: distinct actives in 1, 7 and 30 days. */
  private async activeWindows(
    filter: ResolvedMemberFilter,
    buckets: Bucket[],
  ): Promise<Array<{ t: string; dau: number; wau: number; mau: number }>> {
    if (!buckets.length) return [];

    const ends = Prisma.join(
      buckets.map((bucket, index) => Prisma.sql`(${index}::int, ${bucket.lastDay}::date)`),
      ', ',
    );

    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ position: number; dau: bigint; wau: bigint; mau: bigint }>>`
        WITH ${this.pop(filter)},
        ends (position, as_of) AS (VALUES ${ends}),
        acted AS (
          SELECT a."user_id", a."day"
          FROM "user_daily_activity" a
          JOIN pop ON pop."user_id" = a."user_id"
        )
        SELECT e.position AS position,
               COUNT(DISTINCT CASE WHEN acted."day" = e.as_of THEN acted."user_id" END) AS dau,
               COUNT(DISTINCT CASE WHEN acted."day" > e.as_of - 7 THEN acted."user_id" END) AS wau,
               COUNT(DISTINCT CASE WHEN acted."day" > e.as_of - 30 THEN acted."user_id" END) AS mau
        FROM ends e
        LEFT JOIN acted ON acted."day" <= e.as_of AND acted."day" > e.as_of - 30
        GROUP BY 1
      `,
    );

    const byPosition = new Map(rows.map(row => [Number(row.position), row]));

    return buckets.map((bucket, position) => {
      const row = byPosition.get(position);

      return {
        t: bucket.key,
        dau: Number(row?.dau ?? 0),
        wau: Number(row?.wau ?? 0),
        mau: Number(row?.mau ?? 0),
      };
    });
  }

  /**
   * Stickiness: the fraction of a month's members who turn up on a given day.
   *
   * Null where the MAU behind it is below the floor — §2.7 withholds "ratios derived from
   * suppressed counts", and 0.33 out of three people is a disclosure wearing a decimal point.
   */
  private async stickiness(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
  ): Promise<TimeSeriesChart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);
    const windows = await this.activeWindows(filter, buckets);

    return {
      kind: 'timeseries',
      granularity: range.granularity,
      unit: 'ratio',
      series: [
        {
          key: 'stickiness',
          label: 'Stickiness',
          points: windows.map(window => ({
            t: window.t,
            v:
              window.mau >= SUPPRESSION_FLOOR
                ? Math.round((window.dau / window.mau) * 1000) / 1000
                : null,
          })),
        },
      ],
    };
  }

  // ─── Retention ─────────────────────────────────────────────────────────────

  /**
   * The cohort grid: of the people who joined in month M, how many came back in month M+k.
   *
   * Eighteen monthly cohorts, which is the chart everybody recognises. Cohorts are **sign-up**
   * months rather than anything to do with the selected range, because a retention grid restricted
   * to the range would only ever show the top-left corner of itself.
   */
  private async retentionCohorts(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
  ): Promise<CohortChart> {
    const firstMonth = `${shiftDateOnly(`${range.to.slice(0, 7)}-01`, -(COHORT_MONTHS * 31)).slice(0, 7)}-01`;

    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ cohort: Date; size: bigint; offset: number; retained: bigint }>>`
        WITH ${this.pop(filter)},
        cohorts AS (
          SELECT pop."user_id", date_trunc('month', pop."created_day")::date AS m0
          FROM pop
          WHERE pop."created_day" >= ${firstMonth}::date AND pop."created_day" <= ${range.to}::date
        ),
        months AS (
          SELECT DISTINCT a."user_id", date_trunc('month', a."day")::date AS m
          FROM "user_daily_activity" a
          JOIN cohorts ON cohorts."user_id" = a."user_id"
        )
        SELECT c.m0 AS cohort,
               (SELECT COUNT(*) FROM cohorts c2 WHERE c2.m0 = c.m0) AS size,
               (EXTRACT(YEAR FROM age(months.m, c.m0)) * 12
                 + EXTRACT(MONTH FROM age(months.m, c.m0)))::int AS offset,
               COUNT(DISTINCT months."user_id") AS retained
        FROM cohorts c
        JOIN months ON months."user_id" = c."user_id" AND months.m >= c.m0
        GROUP BY 1, 3
        ORDER BY 1, 3
      `,
    );

    const byCohort = new Map<string, { size: number; retained: Map<number, number> }>();

    for (const row of rows) {
      const cohort = dayKey(row.cohort).slice(0, 7);
      const entry = byCohort.get(cohort) ?? { size: Number(row.size), retained: new Map() };

      entry.retained.set(Number(row.offset), Number(row.retained));
      byCohort.set(cohort, entry);
    }

    const months = [...byCohort.keys()].sort();
    // The furthest offset anybody reached, plus one — not the *number* of offsets present. A cohort
    // active in months 0 and 5 and nowhere between has two entries and needs six columns; sized by
    // the count, its month-5 figure fell off the end of its own row.
    const furthest = Math.max(
      0,
      ...[...byCohort.values()].flatMap(entry => [...entry.retained.keys()]),
    );
    const width = furthest + 1;

    return {
      kind: 'cohort',
      period: 'month',
      cohorts: months.map(cohort => {
        const entry = byCohort.get(cohort)!;

        return {
          cohort,
          size: entry.size,
          // A fraction, so the grid reads as percentages whatever the cohort sizes. Offset 0 is
          // the sign-up month itself, which is never 100% — somebody can join and never return.
          retention: Array.from({ length: width }, (_, offset): Num => {
            const retained = entry.retained.get(offset);

            return retained === undefined
              ? null
              : Math.round((retained / entry.size) * 1000) / 1000;
          }),
        };
      }),
    };
  }

  /**
   * D1, D7 and D30: did somebody come back on the day after they joined, a week later, a month on.
   *
   * The cohort is sign-ups in `[from − n, to − n]`, which is the detail that makes this honest:
   * every member of it has had n days to come back by `to`, so D30 is defined even for a 30-day
   * range. Measured over the range as sent, a D30 would be computed from people who joined
   * yesterday and would read as a collapse.
   */
  private async retentionDn(filter: ResolvedMemberFilter, range: ResolvedRange): Promise<Chart> {
    const cards = await Promise.all(
      DN_OFFSETS.map(async offset => {
        const value = await this.dnFor(filter, range.from, range.to, offset);

        return [`d${offset}`, value] as const;
      }),
    );

    const weeks = bucketsFor(range.from, range.to, 'week');
    const trend = await Promise.all(
      DN_OFFSETS.map(async offset => ({
        key: `d${offset}`,
        label: `D${offset}`,
        points: await Promise.all(
          weeks.map(async week => ({
            t: week.key,
            v: await this.dnFor(filter, week.key, week.lastDay, offset),
          })),
        ),
      })),
    );

    return {
      kind: 'group',
      items: {
        ...Object.fromEntries(
          cards.map(([key, value]) => [
            key,
            {
              kind: 'kpi' as const,
              value,
              previous: null,
              changePct: null,
              unit: 'ratio' as const,
              sparkline: [],
            },
          ]),
        ),
        trend: {
          kind: 'timeseries' as const,
          granularity: 'week' as const,
          unit: 'ratio' as const,
          series: trend,
        },
      },
    };
  }

  /**
   * One Dn figure, or null.
   *
   * Null in two cases, both of which are "we cannot say yet" rather than "nobody came back": a
   * cohort whose members have not all reached day n, and a cohort below the suppression floor. A
   * zero in either place would read as a product failure.
   */
  private async dnFor(
    filter: ResolvedMemberFilter,
    from: string,
    to: string,
    offset: number,
  ): Promise<Num> {
    const cohortFrom = shiftDateOnly(from, -offset);
    const cohortTo = shiftDateOnly(to, -offset);

    const [row] = await this.runner.query(
      tx => tx.$queryRaw<Array<{ size: bigint; retained: bigint }>>`
        WITH ${this.pop(filter)},
        cohort AS (
          SELECT pop."user_id", pop."created_day"
          FROM pop
          WHERE pop."created_day" >= ${cohortFrom}::date AND pop."created_day" <= ${cohortTo}::date
        )
        SELECT COUNT(*) AS size,
               COUNT(
                 CASE WHEN EXISTS (
                   SELECT 1 FROM "user_daily_activity" a
                   WHERE a."user_id" = cohort."user_id"
                     AND a."day" = cohort."created_day" + ${offset}::int
                 ) THEN 1 END
               ) AS retained
        FROM cohort
      `,
    );

    const size = Number(row?.size ?? 0);

    if (size < SUPPRESSION_FLOOR) return null;

    return Math.round((Number(row?.retained ?? 0) / size) * 1000) / 1000;
  }

  // ─── Onboarding ────────────────────────────────────────────────────────────

  /**
   * The five steps between signing up and doing something.
   *
   * The cohort is sign-ups in the range, so the funnel describes the people who arrived while it
   * was open rather than everybody who ever did — a lifetime funnel improves forever and tells you
   * nothing about last week's changes.
   */
  private async onboardingFunnel(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
  ): Promise<FunnelChart> {
    const reached = Prisma.join(
      FUNNEL_STEPS.filter(step => step.column).map(
        step => Prisma.sql`COUNT(p.${Prisma.raw(`"${step.column}"`)}) AS ${Prisma.raw(step.key)}`,
      ),
      ', ',
    );

    const [row] = await this.runner.query(
      tx => tx.$queryRaw<Array<Record<string, bigint>>>`
        WITH ${this.pop(filter)}
        SELECT COUNT(*) AS registered, ${reached}
        FROM pop
        LEFT JOIN "user_profile" p ON p."user_id" = pop."user_id"
        WHERE pop."created_day" >= ${range.from}::date AND pop."created_day" <= ${range.to}::date
      `,
    );

    const values = FUNNEL_STEPS.map(step => Number(row?.[step.key] ?? 0));
    const start = values[0];

    return {
      kind: 'funnel',
      steps: FUNNEL_STEPS.map((step, index) => ({
        key: step.key,
        label: step.label,
        value: values[index],
        // Both ratios, because a funnel is read two ways: "where do people drop out" is step to
        // step, and "how many get all the way" is against the start.
        fromPrevious: index === 0 ? 1 : ratio(values[index], values[index - 1]),
        fromStart: ratio(values[index], start),
      })),
    };
  }

  // ─── Where members come from, and what they are on ─────────────────────────

  private async signupMethods(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
  ): Promise<BreakdownChart> {
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ key: string | null; total: bigint }>>`
        WITH ${this.pop(filter)}
        SELECT pop."signup_method" AS key, COUNT(*) AS total
        FROM pop
        WHERE pop."created_day" <= ${range.to}::date
        GROUP BY 1
      `,
    );

    return toBreakdown(rows, { unknownLabel: 'Not recorded' });
  }

  /**
   * What members are on, counted over those active in the range.
   *
   * Over the *active* members rather than all of them, because a platform's device mix is a fact
   * about the people using it. Somebody who signed up on an old phone two years ago and never came
   * back should not tilt the answer to a question about what to build for.
   */
  private async platforms(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
  ): Promise<BreakdownChart> {
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ key: string | null; total: bigint }>>`
        WITH ${this.pop(filter)}
        SELECT pop."platform" AS key, COUNT(DISTINCT pop."user_id") AS total
        FROM pop
        JOIN "user_daily_activity" a ON a."user_id" = pop."user_id"
        WHERE a."day" >= ${range.from}::date AND a."day" <= ${range.to}::date
        GROUP BY 1
      `,
    );

    return toBreakdown(rows, { unknownLabel: 'Unknown' });
  }

  /**
   * Which builds people are actually on, day by day.
   *
   * From `user_daily_activity`, which snapshots the version as it was on the day — the live column
   * on the account says what they are on now and would rewrite the whole of history every time
   * somebody updated the app.
   */
  private async appVersionAdoption(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
  ): Promise<TimeSeriesChart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ day: Date; version: string | null; total: bigint }>>`
        WITH ${this.pop(filter)}
        SELECT a."day" AS day, a."app_version" AS version, COUNT(DISTINCT a."user_id") AS total
        FROM "user_daily_activity" a
        JOIN pop ON pop."user_id" = a."user_id"
        WHERE a."day" >= ${range.from}::date AND a."day" <= ${range.to}::date
        GROUP BY 1, 2
      `,
    );

    const totals = new Map<string, number>();

    for (const row of rows) {
      const version = row.version ?? 'UNKNOWN';

      totals.set(version, (totals.get(version) ?? 0) + Number(row.total));
    }

    const top = [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_VERSIONS)
      .map(([version]) => version);
    const keys = [...top, 'OTHER'];
    const index = indexByDay(buckets);
    const series = new Map(keys.map(key => [key, buckets.map(() => 0)]));

    for (const row of rows) {
      const position = index.get(dayKey(row.day));

      if (position === undefined) continue;

      const version = row.version ?? 'UNKNOWN';
      const key = top.includes(version) ? version : 'OTHER';

      series.get(key)![position] += Number(row.total);
    }

    return {
      kind: 'timeseries',
      granularity: range.granularity,
      unit: 'members',
      series: keys
        // `OTHER` is dropped when nothing fell into it, rather than drawn as a flat zero.
        .filter(key => key !== 'OTHER' || series.get('OTHER')!.some(value => value > 0))
        .map(key => ({
          key,
          label: key === 'UNKNOWN' ? 'Not recorded' : key === 'OTHER' ? 'Other' : key,
          points: buckets.map((bucket, position) => ({
            t: bucket.key,
            v: series.get(key)![position],
          })),
        })),
    };
  }

  /**
   * New, returning and reactivated — the three ways somebody can be active in a bucket.
   *
   * The distinction worth having: growth that is all `new` is a leaky bucket, and `reactivated`
   * is the only one of the three that says a dormant member came back. "Not active in the previous
   * thirty days but signed up before this bucket" is what makes it reactivated rather than new.
   */
  private async newReturningReactivated(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
  ): Promise<TimeSeriesChart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);

    if (!buckets.length) {
      return { kind: 'timeseries', granularity: range.granularity, unit: 'members', series: [] };
    }

    const bounds = Prisma.join(
      buckets.map(
        (bucket, index) =>
          Prisma.sql`(${index}::int, ${bucket.key}::date, ${bucket.lastDay}::date)`,
      ),
      ', ',
    );

    const rows = await this.runner.query(
      tx => tx.$queryRaw<
        Array<{ position: number; fresh: bigint; returning: bigint; reactivated: bigint }>
      >`
        WITH ${this.pop(filter)},
        buckets (position, starts, ends) AS (VALUES ${bounds}),
        acted AS (
          SELECT a."user_id", a."day", pop."created_day"
          FROM "user_daily_activity" a
          JOIN pop ON pop."user_id" = a."user_id"
        ),
        -- Everybody active in each bucket, with the two facts that classify them.
        present AS (
          SELECT DISTINCT b.position,
                 acted."user_id",
                 acted."created_day",
                 b.starts
          FROM buckets b
          JOIN acted ON acted."day" >= b.starts AND acted."day" <= b.ends
        )
        SELECT b.position AS position,
               COUNT(CASE WHEN p."created_day" >= b.starts THEN 1 END) AS fresh,
               COUNT(CASE WHEN p."created_day" < b.starts AND EXISTS (
                 SELECT 1 FROM "user_daily_activity" a2
                 WHERE a2."user_id" = p."user_id"
                   AND a2."day" < b.starts AND a2."day" >= b.starts - 30
               ) THEN 1 END) AS returning,
               COUNT(CASE WHEN p."created_day" < b.starts AND NOT EXISTS (
                 SELECT 1 FROM "user_daily_activity" a2
                 WHERE a2."user_id" = p."user_id"
                   AND a2."day" < b.starts AND a2."day" >= b.starts - 30
               ) THEN 1 END) AS reactivated
        FROM buckets b
        LEFT JOIN present p ON p.position = b.position
        GROUP BY 1
      `,
    );

    const byPosition = new Map(rows.map(row => [Number(row.position), row]));
    const pick = (key: 'fresh' | 'returning' | 'reactivated') =>
      buckets.map((bucket, position) => ({
        t: bucket.key,
        v: Number(byPosition.get(position)?.[key] ?? 0),
      }));

    return {
      kind: 'timeseries',
      granularity: range.granularity,
      unit: 'members',
      series: [
        { key: 'new', label: 'New', points: pick('fresh') },
        { key: 'returning', label: 'Returning', points: pick('returning') },
        { key: 'reactivated', label: 'Reactivated', points: pick('reactivated') },
      ],
    };
  }
}

/** The three numbers a membership curve is built from. */
interface MembershipCounts {
  /** How many were members the day before the range opened. */
  before: number;
  joined: Array<{ day: Date; total: bigint }>;
  left: Array<{ day: Date; total: bigint }>;
}

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

/** Whether anything narrows the population, as opposed to only narrowing the dates. */
const hasMemberFilters = (input: MemberFilterInput): boolean =>
  [
    input.cityIds,
    input.gender,
    input.ageBands,
    input.countriesOfOrigin,
    input.heritage,
    input.journeyStages,
    input.interests,
    input.languages,
    input.platforms,
    input.appVersions,
    input.signupMethods,
    input.statuses,
  ].some(values => (values?.length ?? 0) > 0) || input.onboarding !== undefined;
