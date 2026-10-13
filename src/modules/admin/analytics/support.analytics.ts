import { Injectable } from '@nestjs/common';
import {
  DisputeReason,
  DisputeState,
  Prisma,
  SupportThreadState,
  SupportThreadType,
} from '@prisma/client';
import { AnalyticsRunnerService } from './analytics-runner.service';
import { BreakdownChart, Chart, MatrixChart, Num, Point, TimeSeriesChart } from './chart.types';
import { bucketsFor, indexByDay } from './buckets';
import { toBreakdown, toMatrix } from './breakdown';
import { ResolvedMemberFilter, ResolvedRange } from '../filters/member-filter.builder';
import { SupportFilters } from '../dtos/admin-analytics.dto';

/**
 * The states that mean "still somebody's work", as §7.6 and the inbox define them.
 *
 * Exported so `support-charts.spec.ts` can hold them against the enum: a sixth state added without
 * a decision about which side of this line it falls on would silently change what
 * `workloadPerAgent` calls an open thread.
 */
export const OPEN_THREAD_STATES: SupportThreadState[] = [
  SupportThreadState.NEW,
  SupportThreadState.OPEN,
  SupportThreadState.WAITING_ON_MEMBER,
];

/**
 * Support (§5.25).
 *
 * All five charts read their own tables now. Four of them answered
 * `{ kind: 'error', code: 'NOT_AVAILABLE_YET' }` until §4.8's `support_threads` existed — the tab
 * shipped with one real chart rather than being withheld, which is what that code is for — and
 * this is the stage that fills them in.
 *
 * Two things shape every query here:
 *
 *  - **Nothing is a count of members.** A thread is the unit of work, and one member can open
 *    several; so the unit is `count` throughout and §2.7's magnitude floor does not apply, which
 *    is also how "staff counts are never suppressed" comes out right without an exemption.
 *  - **`GUARD` threads are included.** This tab opens on `analytics:read`, which the support team
 *    hold — but a chart is an aggregate over a range, not a thread anybody can open, and
 *    "disclosures were 4% of the week" is a number a support lead needs in order to staff the
 *    week. `threadTypes` can narrow to or away from them, and `workloadPerAgent` names staff
 *    rather than members, so nothing here identifies a member who disclosed something.
 */
@Injectable()
export class SupportAnalytics {
  constructor(private readonly runner: AnalyticsRunnerService) {}

  static readonly FILTER_SEMANTICS: Record<string, string> = {
    threadTypes:
      '`SupportThreadType` on the four thread charts. `disputesByReasonOutcome` ignores it: a ' +
      'dispute is its own record with its own reason, and a thread type is not a property of one.',
    assigneeIds:
      'who the thread is assigned to **now**, on the four thread charts. `workloadPerAgent` is ' +
      'therefore a chart of the agents asked for rather than of the whole team, which is what ' +
      '"show me these two people" means. A thread nobody holds is excluded by any value here, ' +
      'because an unassigned thread is not assigned to the person asked about.',
    memberFilters:
      'the member the thread is with, and for `disputesByReasonOutcome` the member who raised ' +
      'the dispute. Both are "whose problem is this", which is the only member a support record ' +
      'has.',
  };

  charts(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: SupportFilters,
  ): Record<string, () => Promise<Chart>> {
    return {
      openedResolved: () => this.openedResolved(filter, range, extra),
      responseTimes: () => this.responseTimes(filter, range, extra),
      threadsByType: () => this.threadsByType(filter, range, extra),
      workloadPerAgent: () => this.workloadPerAgent(filter, range, extra),
      disputesByReasonOutcome: () => this.disputesByReasonOutcome(filter, range, extra),
    };
  }

  /**
   * The population, and how `support_threads` joins to it.
   *
   * With no member filter in force the join is skipped rather than made permissive, for the same
   * reason as every other tab: `mv_member_dimensions` excludes anonymised accounts, so joining to
   * it unconditionally would drop every thread with somebody who has since deleted their account —
   * and a chart of what support handled in March must not change when a member leaves in April.
   */
  private scope(filter: ResolvedMemberFilter, extra: SupportFilters): Prisma.Sql {
    const parts: Prisma.Sql[] = [];

    if (extra.hasMemberFilters) {
      parts.push(
        Prisma.sql`EXISTS (
          SELECT 1 FROM "mv_member_dimensions" m
          WHERE m."user_id" = t."member_id" AND ${filter.viewSql}
        )`,
      );
    }

    if (extra.threadTypes?.length) {
      parts.push(Prisma.sql`t."type"::text IN (${Prisma.join(extra.threadTypes)})`);
    }

    if (extra.assigneeIds?.length) {
      // No `OR assigned_to_id IS NULL`: asking for two agents' work and being handed the
      // unassigned queue as well would make every agent's bar wrong by the same amount.
      parts.push(Prisma.sql`t."assigned_to_id" IN (${Prisma.join(extra.assigneeIds)})`);
    }

    return parts.length ? Prisma.sql`AND ${Prisma.join(parts, ' AND ')}` : Prisma.empty;
  }

  /**
   * Threads opened against threads settled, per bucket.
   *
   * Two series from two different columns of the same table, which is why they are counted in two
   * passes and not one: a thread opened in March and resolved in April belongs to March's
   * `opened` and April's `resolved`, and a single `GROUP BY created_at` could only ever report one
   * of those. The pair is the point of the chart — a week where the lines cross is a week the
   * backlog turned.
   */
  private async openedResolved(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: SupportFilters,
  ): Promise<TimeSeriesChart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);
    const scope = this.scope(filter, extra);
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ day: Date; opened: bigint; resolved: bigint }>>`
        SELECT day, SUM(opened) AS opened, SUM(resolved) AS resolved
        FROM (
          SELECT (t."created_at" AT TIME ZONE 'Europe/London')::date AS day, 1 AS opened, 0 AS resolved
          FROM "support_threads" t
          WHERE t."created_at" >= ${range.fromInstant} AND t."created_at" < ${range.toInstant}
            ${scope}
          UNION ALL
          SELECT (t."resolved_at" AT TIME ZONE 'Europe/London')::date AS day, 0 AS opened, 1 AS resolved
          FROM "support_threads" t
          WHERE t."resolved_at" IS NOT NULL
            AND t."resolved_at" >= ${range.fromInstant} AND t."resolved_at" < ${range.toInstant}
            ${scope}
        ) events
        GROUP BY 1
      `,
    );

    const index = indexByDay(buckets);
    const opened = buckets.map(() => 0);
    const resolved = buckets.map(() => 0);

    for (const row of rows) {
      const position = index.get(dayKey(row.day));

      if (position === undefined) continue;

      opened[position] += Number(row.opened);
      resolved[position] += Number(row.resolved);
    }

    return {
      kind: 'timeseries',
      granularity: range.granularity,
      // Threads, not members: one member can open several and each is a piece of work.
      unit: 'count',
      series: [
        {
          key: 'opened',
          label: 'Opened',
          points: buckets.map((bucket, at) => ({ t: bucket.key, v: opened[at] })),
        },
        {
          key: 'resolved',
          label: 'Resolved',
          points: buckets.map((bucket, at) => ({ t: bucket.key, v: resolved[at] })),
        },
      ],
    };
  }

  /**
   * How long people wait, as medians (§8.4).
   *
   * Medians rather than means, and `null` rather than `0` for a bucket with nothing to measure:
   * one thread that sat over Christmas drags a mean past every real experience, and a day on which
   * nothing was answered is not a response time of zero.
   *
   * `firstResponse` measures from the member's **first message**, not from the thread's creation.
   * Four of the five thread types are opened by Circl — a managed request, a brief, a deal problem
   * — so measuring from `created_at` would report the gap between us opening a thread and us
   * replying in it, which is not a wait anybody experienced. Threads with no member message yet are
   * excluded entirely rather than counted as instant.
   *
   * `resolution` does measure from `created_at`, because that is when the work arrived.
   */
  private async responseTimes(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: SupportFilters,
  ): Promise<Chart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);
    const scope = this.scope(filter, extra);
    const rows = await this.runner.query(
      tx => tx.$queryRaw<
        Array<{ day: Date; first_response: number | null; resolution: number | null }>
      >`
        SELECT (t."created_at" AT TIME ZONE 'Europe/London')::date AS day,
               PERCENTILE_CONT(0.5) WITHIN GROUP (
                 ORDER BY EXTRACT(EPOCH FROM (t."first_response_at" - t."first_member_message_at")) / 60
               ) FILTER (
                 WHERE t."first_response_at" IS NOT NULL AND t."first_member_message_at" IS NOT NULL
               ) AS first_response,
               PERCENTILE_CONT(0.5) WITHIN GROUP (
                 ORDER BY EXTRACT(EPOCH FROM (t."resolved_at" - t."created_at")) / 60
               ) FILTER (WHERE t."resolved_at" IS NOT NULL) AS resolution
        FROM "support_threads" t
        WHERE t."created_at" >= ${range.fromInstant} AND t."created_at" < ${range.toInstant}
          ${scope}
        GROUP BY 1
      `,
    );

    // The headline is the median over the whole range, which is **not** the median of the daily
    // medians — a day with one thread would weigh as much as a day with two hundred. So it is a
    // second pass over the same rows rather than an average of the series.
    const [overall] = await this.runner.query(
      tx => tx.$queryRaw<Array<{ first_response: number | null; resolution: number | null }>>`
        SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (
                 ORDER BY EXTRACT(EPOCH FROM (t."first_response_at" - t."first_member_message_at")) / 60
               ) FILTER (
                 WHERE t."first_response_at" IS NOT NULL AND t."first_member_message_at" IS NOT NULL
               ) AS first_response,
               PERCENTILE_CONT(0.5) WITHIN GROUP (
                 ORDER BY EXTRACT(EPOCH FROM (t."resolved_at" - t."created_at")) / 60
               ) FILTER (WHERE t."resolved_at" IS NOT NULL) AS resolution
        FROM "support_threads" t
        WHERE t."created_at" >= ${range.fromInstant} AND t."created_at" < ${range.toInstant}
          ${scope}
      `,
    );

    const index = indexByDay(buckets);
    const firstResponse = buckets.map(() => null as Num);
    const resolution = buckets.map(() => null as Num);

    for (const row of rows) {
      const position = index.get(dayKey(row.day));

      if (position === undefined) continue;

      if (row.first_response !== null)
        firstResponse[position] = Math.round(Number(row.first_response));
      if (row.resolution !== null) resolution[position] = Math.round(Number(row.resolution));
    }

    const points = (values: Num[]): Point[] =>
      buckets.map((bucket, at) => ({ t: bucket.key, v: values[at] }));
    const minutes = (value: number | null | undefined): Num =>
      value === null || value === undefined ? null : Math.round(Number(value));

    return {
      kind: 'group',
      items: {
        firstResponse: {
          kind: 'kpi',
          value: minutes(overall?.first_response),
          // No previous period on either. A median over a handful of threads moves on one slow
          // afternoon, so a change percentage would be noise presented as a trend; the series
          // beside it is the honest form of the same comparison.
          previous: null,
          changePct: null,
          unit: 'minutes',
          sparkline: points(firstResponse),
        },
        resolution: {
          kind: 'kpi',
          value: minutes(overall?.resolution),
          previous: null,
          changePct: null,
          unit: 'minutes',
          sparkline: points(resolution),
        },
        trend: {
          kind: 'timeseries',
          granularity: range.granularity,
          unit: 'minutes',
          series: [
            { key: 'firstResponse', label: 'First response', points: points(firstResponse) },
            { key: 'resolution', label: 'Resolution', points: points(resolution) },
          ],
        },
      },
    };
  }

  /**
   * What support is actually about.
   *
   * Every type is declared, so a type nobody opened in the range reads as zero rather than being
   * absent — the shape of the week is the point, and a missing bar is read as a missing chart.
   */
  private async threadsByType(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: SupportFilters,
  ): Promise<BreakdownChart> {
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ key: string; total: bigint }>>`
        SELECT t."type"::text AS key, COUNT(*) AS total
        FROM "support_threads" t
        WHERE t."created_at" >= ${range.fromInstant} AND t."created_at" < ${range.toInstant}
          ${this.scope(filter, extra)}
        GROUP BY 1
      `,
    );

    return toBreakdown(rows, {
      unit: 'count',
      order: Object.values(SupportThreadType),
      labels: new Map(Object.values(SupportThreadType).map(type => [type, titleise(type)])),
    });
  }

  /**
   * Who is carrying what (§5.25).
   *
   * Two breakdowns rather than one, because they answer two different questions and a support lead
   * needs both: `assignedOpen` is "what is on somebody's desk right now" — as of the moment of
   * asking, not of the range — and `resolvedInRange` is "what did they get through". A single
   * chart of either alone reads as the other and gets somebody judged on a queue they inherited.
   *
   * `assignedOpen` therefore deliberately ignores the date range, which is the one place on this
   * tab where that is true. A queue is a present-tense fact; filtering it to threads created this
   * month would hide the three from last month that are the actual problem.
   *
   * Unassigned threads are their own row. Dropping them would make the chart claim the team holds
   * everything, and the number nobody has is the one a lead acts on first.
   */
  private async workloadPerAgent(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: SupportFilters,
  ): Promise<Chart> {
    const scope = this.scope(filter, extra);
    const [open, resolved] = await Promise.all([
      this.runner.query(
        tx => tx.$queryRaw<Array<{ key: string | null; label: string | null; total: bigint }>>`
          SELECT t."assigned_to_id" AS key,
                 TRIM(CONCAT(u."first_name", ' ', COALESCE(u."last_name", ''))) AS label,
                 COUNT(*) AS total
          FROM "support_threads" t
          LEFT JOIN "users" u ON u."id" = t."assigned_to_id"
          WHERE t."state"::text IN (${Prisma.join([...OPEN_THREAD_STATES])})
            ${scope}
          GROUP BY 1, 2
        `,
      ),
      this.runner.query(
        tx => tx.$queryRaw<Array<{ key: string | null; label: string | null; total: bigint }>>`
          SELECT t."assigned_to_id" AS key,
                 TRIM(CONCAT(u."first_name", ' ', COALESCE(u."last_name", ''))) AS label,
                 COUNT(*) AS total
          FROM "support_threads" t
          LEFT JOIN "users" u ON u."id" = t."assigned_to_id"
          WHERE t."resolved_at" IS NOT NULL
            AND t."resolved_at" >= ${range.fromInstant} AND t."resolved_at" < ${range.toInstant}
            ${scope}
          GROUP BY 1, 2
        `,
      ),
    ]);

    // Staff counts are never suppressed (§5.25), and they are not: the unit is a count of threads
    // rather than of members, which is the only unit §2.7's floor applies to. Said out loud
    // because "three threads" looking suppressible is exactly the mistake somebody would make.
    const breakdown = (
      rows: Array<{ key: string | null; label: string | null; total: bigint }>,
    ): BreakdownChart =>
      toBreakdown(
        rows.map(row => ({ key: row.key, label: row.label || null, total: row.total })),
        { unit: 'count', unknownLabel: 'Unassigned' },
      );

    return {
      kind: 'group',
      items: { assignedOpen: breakdown(open), resolvedInRange: breakdown(resolved) },
    };
  }

  /**
   * Why disputes are raised, against how they end.
   *
   * Rows are the reason the member gave, columns the state the dispute reached — including `OPEN`
   * and `IN_REVIEW`, which are not outcomes yet. Dropping them would make a chart of a recent
   * range read as though every dispute had been settled, and the unresolved column is the one a
   * support lead is looking for.
   *
   * `WITHDRAWN` is kept distinct from `RESOLVED`: a member thinking better of it and a dispute
   * somebody worked through are opposite facts about the same reason code.
   */
  private async disputesByReasonOutcome(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: SupportFilters,
  ): Promise<MatrixChart> {
    const parts: Prisma.Sql[] = [];

    if (extra.hasMemberFilters) {
      parts.push(
        Prisma.sql`EXISTS (
          SELECT 1 FROM "mv_member_dimensions" m
          WHERE m."user_id" = d."raised_by_id" AND ${filter.viewSql}
        )`,
      );
    }

    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ row: string; col: string; total: bigint }>>`
        SELECT d."reason_code"::text AS row, d."state"::text AS col, COUNT(*) AS total
        FROM "disputes" d
        WHERE d."created_at" >= ${range.fromInstant} AND d."created_at" < ${range.toInstant}
          ${parts.length ? Prisma.sql`AND ${Prisma.join(parts, ' AND ')}` : Prisma.empty}
        GROUP BY 1, 2
      `,
    );

    return toMatrix(rows, {
      // Disputes, not members: one member can raise several, and a dispute is the unit of work.
      unit: 'count',
      rows: Object.values(DisputeReason).map(reason => ({
        key: reason,
        label: titleise(reason),
      })),
      cols: Object.values(DisputeState).map(state => ({ key: state, label: titleise(state) })),
    });
  }
}

const titleise = (code: string): string =>
  code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, ' ');

const dayKey = (day: Date): string => day.toISOString().slice(0, 10);
