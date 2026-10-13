import { Injectable } from '@nestjs/common';
import {
  AppealState,
  ContentRiskTier,
  ModerationDecision,
  ModerationQueueType,
  Prisma,
  ReportCasePriority,
  ReportCaseState,
  ReportReason,
  ReportTargetType,
  RiskCategory,
  // Still needed by `guardCases`: a Guard thread carries a `risk_level`, which is the one place on
  // this tab that charts the level rather than a scan's tier or a case's priority.
  RiskLevel,
} from '@prisma/client';
import { AnalyticsRunnerService } from './analytics-runner.service';
import {
  BreakdownChart,
  Chart,
  KpiChart,
  MatrixChart,
  Num,
  Point,
  TableChart,
  TimeSeriesChart,
} from './chart.types';
import { Bucket, bucketsFor, indexByDay } from './buckets';
import { toBreakdown, toMatrix } from './breakdown';
import { ResolvedMemberFilter, ResolvedRange } from '../filters/member-filter.builder';
import { SafetyFilters } from '../dtos/admin-analytics.dto';

/** How many target types the breakdown names before the rest become `other`. */
const TARGET_ROWS = 12;

/** How many terms the lexicon table returns. */
const TERM_ROWS = 20;

export const PRIORITIES = [
  ReportCasePriority.URGENT,
  ReportCasePriority.HIGH,
  ReportCasePriority.NORMAL,
] as const;

/**
 * The two state names `ReportState` and `ReportCaseState` share.
 *
 * The `states` filter is declared over the first and three charts are sourced from a table that
 * carries the second, so these are the values that mean the same thing on both.
 */
export const CASE_STATES = [ReportCaseState.ACTIONED, ReportCaseState.DISMISSED] as const;

/**
 * An appeal that was actually answered.
 *
 * `WITHDRAWN` is the member changing their mind, which is theirs to do and says nothing about
 * whether the decision was right; an open one has no outcome at all. Both would sit in the
 * denominator and push the overturn rate down — and a number whose job is to catch a reviewer
 * being wrong too often must not be flattered by the appeals nobody answered.
 */
export const APPEAL_OUTCOMES = [AppealState.UPHELD, AppealState.OVERTURNED] as const;

/** The tiers the flagged matrix charts. `CLEAN` is not a flag, and would dwarf every real row. */
export const FLAGGED_TIERS = [
  ContentRiskTier.LOW,
  ContentRiskTier.MEDIUM,
  ContentRiskTier.HIGH,
  ContentRiskTier.CRITICAL,
] as const;

/**
 * §5.25: "`REMOVE_AND_*` count under their strongest action."
 *
 * A suspension outlives the removal that came with it, so `REMOVE_AND_SUSPEND` reads as a
 * suspension; a warning does not outlive the removal, so `REMOVE_AND_WARN` reads as a removal.
 * Folded so the bar has the five bands §5.25 names rather than seven, two of which would
 * double-count the same severity under a longer label.
 */
export const FOLDED_DECISION: Partial<Record<ModerationDecision, ModerationDecision>> = {
  [ModerationDecision.REMOVE_AND_SUSPEND]: ModerationDecision.SUSPEND_AUTHOR,
  [ModerationDecision.REMOVE_AND_WARN]: ModerationDecision.REMOVE_CONTENT,
};

/**
 * Queue types this tab must never count.
 *
 * `PROFESSIONAL_REVIEW` (§2.9) shares the queue table and is not moderation work: it is an
 * approval for somebody who wants to offer a regulated service, with its own endpoint, its own two
 * verbs and no accusation attached. Counting it among decided moderation items makes every figure
 * on this tab wrong in a way that looks like the platform got slower.
 */
export const NOT_MODERATION: readonly string[] = ['PROFESSIONAL_REVIEW'];

/**
 * The decision mix, strongest action first, so the bar reads as a severity scale.
 *
 * The five bands §5.25 names, which are also exactly what survives the fold of `CASE_DECISIONS`:
 * a case can be decided seven ways and `REMOVE_AND_*` count under their strongest action.
 * `ESCALATE_GUARD` sits at the end rather than by severity — it is not a moderation outcome at
 * all, it is the case being handed to safeguarding, and putting it between two outcomes would read
 * as a verdict somewhere in the middle.
 */
export const DECISION_ORDER = [
  ModerationDecision.SUSPEND_AUTHOR,
  ModerationDecision.REMOVE_CONTENT,
  ModerationDecision.WARN_AUTHOR,
  ModerationDecision.NO_ACTION,
  ModerationDecision.ESCALATE_GUARD,
] as const;

/**
 * Trust & Safety (§5.25). All ten charts, each from the source §5.25 names.
 *
 * It did not start that way. This tab was written while the safety milestone was half-built, so
 * five charts read substitutes — the moderation queue standing in for `report_cases` and for
 * `content_safety`, matched phrases unnested out of a JSON column standing in for
 * `risk_term_hits` — and `appealOverturn` was a `NOT_AVAILABLE_YET` slot because appeals had no
 * table at all. Those tables now exist and every chart has been moved onto its own, which changed
 * four of the numbers: see each method for what it used to measure and why that was wrong.
 *
 * One substitution **stays**, and it is an improvement rather than a shortfall: `queueBacklog`
 * derives the backlog from openings and closures instead of reading `moderation_backlog_daily`, a
 * nightly snapshot table. Derived, the series is exact and cannot drift from the live queue the
 * dashboard counts. The snapshot table is not worth building to make a chart less accurate.
 *
 * The one thing to keep in mind when reading any of it: a filter bar shared by ten charts over
 * five tables means the same filter reaches different columns, and in two cases a different enum.
 * `FILTER_SEMANTICS` says so in the payload rather than leaving somebody to infer it from a count
 * that did not move.
 */
@Injectable()
export class SafetyAnalytics {
  constructor(private readonly runner: AnalyticsRunnerService) {}

  static readonly FILTER_SEMANTICS: Record<string, string> = {
    memberFilters:
      'narrow by the **reported or authoring** member, not the reporter. A report whose subject ' +
      'cannot be resolved to a member is therefore excluded whenever a member filter is in force, ' +
      'and counted when none is.',
    queueTypes:
      'only `queueBacklog`, which is the one chart still read from the moderation queue — every ' +
      'other chart on this tab now reads reports, cases, scans, hits, appeals or suspensions, ' +
      'none of which has a queue type.',
    states:
      'report states (`ReportState`). The three charts read from `report_cases` carry ' +
      '`ReportCaseState` instead, so only the two names the enums share — `ACTIONED` and ' +
      '`DISMISSED` — reach them; the rest is ignored there rather than applied to a column it ' +
      'does not describe. The moderation queue is filtered by `queueTypes`.',
    riskLevels:
      '`RiskLevel` on reports, cases and the queue. `flaggedByTierCategory` reads ' +
      '`content_safety.tier`, whose values are the same but for its floor (`CLEAN`, not `NONE`), ' +
      'and the filter applies to it. `topRiskTerms` ignores it: a hit is a phrase matching a ' +
      'string, and the tier is a verdict on the whole item.',
    riskCategories:
      "the scan's category everywhere except `topRiskTerms`, which reads the **term's** own " +
      'category — "show me the harassment terms" is a question about what a phrase is for, not ' +
      'about what the scanner concluded after weighing every other phrase in the post.',
  };

  charts(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: SafetyFilters,
  ): Record<string, () => Promise<Chart>> {
    return {
      reportsByReason: () => this.reportsByReason(filter, range, extra),
      reportsByTarget: () => this.reportsByTarget(filter, range, extra),
      timeToAction: () => this.timeToAction(filter, range, extra),
      queueBacklog: () => this.queueBacklog(filter, range, extra),
      decisionMix: () => this.decisionMix(filter, range, extra),
      flaggedByTierCategory: () => this.flaggedByTierCategory(filter, range, extra),
      topRiskTerms: () => this.topRiskTerms(filter, range, extra),
      guardCases: () => this.guardCases(filter, range, extra),
      appealOverturn: () => this.appealOverturn(filter, range, extra),
      activeSuspensions: () => this.activeSuspensions(filter, range),
    };
  }

  /**
   * The population, and how a table joins to it.
   *
   * With **no** member filter in force the join is skipped entirely rather than made permissive,
   * and that is deliberate. `mv_member_dimensions` excludes anonymised accounts, so joining to it
   * unconditionally would drop every report about somebody who has since deleted their account —
   * and a chart of what was reported in March must not change when somebody leaves in April. It is
   * the same mistake `cumulativeMembers` made by accumulating a view of today's members.
   */
  private pop(filter: ResolvedMemberFilter): Prisma.Sql {
    return Prisma.sql`
      pop AS (
        SELECT m."user_id" FROM "mv_member_dimensions" m WHERE ${filter.viewSql}
      )`;
  }

  private subject(column: Prisma.Sql, extra: SafetyFilters): Prisma.Sql {
    return extra.hasMemberFilters
      ? Prisma.sql`EXISTS (SELECT 1 FROM pop WHERE pop."user_id" = ${column})`
      : Prisma.sql`TRUE`;
  }

  /** The report filters: reason, target type, state, and the risk the triage assigned. */
  private reportScope(extra: SafetyFilters): Prisma.Sql {
    const parts: Prisma.Sql[] = [];

    if (extra.reasonCodes?.length) {
      parts.push(Prisma.sql`r."reason_code"::text IN (${Prisma.join(extra.reasonCodes)})`);
    }

    if (extra.targetTypes?.length) {
      parts.push(Prisma.sql`r."target_type"::text IN (${Prisma.join(extra.targetTypes)})`);
    }

    if (extra.states?.length) {
      parts.push(Prisma.sql`r."state"::text IN (${Prisma.join(extra.states)})`);
    }

    if (extra.riskLevels?.length) {
      parts.push(Prisma.sql`r."risk_level"::text IN (${Prisma.join(extra.riskLevels)})`);
    }

    if (extra.riskCategories?.length) {
      parts.push(Prisma.sql`r."risk_category"::text IN (${Prisma.join(extra.riskCategories)})`);
    }

    return parts.length ? Prisma.sql`AND ${Prisma.join(parts, ' AND ')}` : Prisma.empty;
  }

  /**
   * The case filters, for the three charts sourced from `report_cases`.
   *
   * `states` is the awkward one. The filter is declared as `ReportState` — the state of an
   * individual report — and a case carries `ReportCaseState`, a different enum that happens to
   * share `ACTIONED` and `DISMISSED`. Rather than refuse the filter or apply it to a column it
   * does not describe, the shared values are applied and the rest ignored: asking for
   * `state=ACTIONED` means the same thing on both tables, and asking for `RECEIVED` is a question
   * about reports that a case cannot answer. Said out loud in `FILTER_SEMANTICS` rather than left
   * for somebody to infer from a count that did not move.
   *
   * `reasonCodes` is an array overlap, because a case collects the reasons of every report in it.
   * A case reported once for spam and once for a scam matches either filter, which is the only
   * reading that does not make "cases reported as a scam" miss the ones that were also spam.
   */
  private caseScope(extra: SafetyFilters): Prisma.Sql {
    const parts: Prisma.Sql[] = [];

    if (extra.reasonCodes?.length) {
      parts.push(
        Prisma.sql`c."reason_codes" && ARRAY[${Prisma.join(extra.reasonCodes)}]::"ReportReason"[]`,
      );
    }

    if (extra.targetTypes?.length) {
      parts.push(Prisma.sql`c."target_type"::text IN (${Prisma.join(extra.targetTypes)})`);
    }

    if (extra.riskLevels?.length) {
      parts.push(Prisma.sql`c."risk_level"::text IN (${Prisma.join(extra.riskLevels)})`);
    }

    const shared = (extra.states ?? []).filter(state =>
      (CASE_STATES as readonly string[]).includes(state),
    );

    if (shared.length) {
      parts.push(Prisma.sql`c."state"::text IN (${Prisma.join(shared)})`);
    }

    return parts.length ? Prisma.sql`AND ${Prisma.join(parts, ' AND ')}` : Prisma.empty;
  }

  /**
   * The scan filters, for the matrix and the lexicon table.
   *
   * `content_safety` has a `tier` where the rest of this tab has a `risk_level`, and the two enums
   * share every value but their floor — `NONE` against `CLEAN`. The `riskLevels` filter is applied
   * to the tier on the four shared names, so one filter bar means one thing across the tab.
   */
  private scanScope(extra: SafetyFilters): Prisma.Sql {
    const parts: Prisma.Sql[] = [];

    if (extra.targetTypes?.length) {
      parts.push(Prisma.sql`cs."target_type"::text IN (${Prisma.join(extra.targetTypes)})`);
    }

    if (extra.riskCategories?.length) {
      parts.push(Prisma.sql`cs."category"::text IN (${Prisma.join(extra.riskCategories)})`);
    }

    const tiers = (extra.riskLevels ?? []).filter(level =>
      (Object.values(ContentRiskTier) as string[]).includes(level),
    );

    if (tiers.length) {
      parts.push(Prisma.sql`cs."tier"::text IN (${Prisma.join(tiers)})`);
    }

    return parts.length ? Prisma.sql`AND ${Prisma.join(parts, ' AND ')}` : Prisma.empty;
  }

  /**
   * The lexicon-table filters.
   *
   * `riskCategories` reads against the **term's** category rather than the scan's, which is the
   * only one that makes the table answer the question asked of it: "show me the harassment terms"
   * is about what the phrase is for, not about what the scanner concluded after weighing every
   * other phrase in the post.
   *
   * `riskLevels` and `targetTypes` are not applied here. A hit is a phrase matching a string; the
   * tier is a verdict on the whole item, and filtering the hit log by it would answer a different
   * question under the same heading.
   */
  private termScope(extra: SafetyFilters): Prisma.Sql {
    if (!extra.riskCategories?.length) return Prisma.empty;

    return Prisma.sql`AND rt."category"::text IN (${Prisma.join(extra.riskCategories)})`;
  }

  /**
   * The queue filters, for `queueBacklog` — which is now the only chart on this tab that reads the
   * queue, and so the only place `queueTypes` has any effect.
   *
   * It used to be eight queries, before each chart moved onto the table §5.25 names. Worth saying
   * out loud, because a filter that narrows one chart out of ten is a filter somebody will reach
   * for expecting it to narrow the tab. `FILTER_SEMANTICS` says so in the payload.
   */
  private queueScope(extra: SafetyFilters): Prisma.Sql {
    // Always, before any caller's filter: the types on this table that are **not** moderation.
    //
    // A `PROFESSIONAL_REVIEW` item is not moderation work — nothing is wrong with the listing and
    // nobody is accused of anything, it is an onboarding approval that happens to live in the same
    // table because it needs a reviewer and a queue. Counted in the backlog it would draw a band
    // of outstanding "moderation" that is nothing of the sort.
    //
    // This mattered more when eight queries passed through here: three approved listings once put
    // a 384-minute median on the time-to-action line, back when that chart read the queue. The
    // exclusion stays in the fragment rather than in the query, for the same reason it was put
    // here — added to §5.9's own default-tab list and forgotten here, it is wrong in an invisible
    // way: a number that is plausible, moves for the wrong reasons, and nobody checks.
    const parts: Prisma.Sql[] = [
      Prisma.sql`q."type"::text NOT IN (${Prisma.join([...NOT_MODERATION])})`,
    ];

    if (extra.queueTypes?.length) {
      parts.push(Prisma.sql`q."type"::text IN (${Prisma.join(extra.queueTypes)})`);
    }

    if (extra.targetTypes?.length) {
      parts.push(Prisma.sql`q."target_type"::text IN (${Prisma.join(extra.targetTypes)})`);
    }

    if (extra.riskLevels?.length) {
      parts.push(Prisma.sql`q."risk_level"::text IN (${Prisma.join(extra.riskLevels)})`);
    }

    if (extra.riskCategories?.length) {
      parts.push(Prisma.sql`q."risk_category"::text IN (${Prisma.join(extra.riskCategories)})`);
    }

    return parts.length ? Prisma.sql`AND ${Prisma.join(parts, ' AND ')}` : Prisma.empty;
  }

  // ─── Reports ───────────────────────────────────────────────────────────────

  /**
   * What is being reported, over time, stacked by reason.
   *
   * Every declared reason gets a band whether or not it was used in this range. A stack that drops
   * its empty bands reorders itself every time the date picker moves, so the same colour means a
   * different thing on two views of the same chart.
   */
  private async reportsByReason(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: SafetyFilters,
  ): Promise<TimeSeriesChart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ reason: string; day: Date; total: bigint }>>`
        WITH ${this.pop(filter)}
        SELECT r."reason_code"::text AS reason,
               (r."created_at" AT TIME ZONE 'Europe/London')::date AS day,
               COUNT(*) AS total
        FROM "reports" r
        WHERE r."created_at" >= ${range.fromInstant} AND r."created_at" < ${range.toInstant}
          AND ${this.subject(Prisma.sql`r."target_user_id"`, extra)}
          ${this.reportScope(extra)}
        GROUP BY 1, 2
      `,
    );

    const wanted = extra.reasonCodes?.length
      ? Object.values(ReportReason).filter(reason => extra.reasonCodes!.includes(reason))
      : Object.values(ReportReason);

    return {
      kind: 'timeseries',
      granularity: range.granularity,
      // Reports, not reporters. One member filing eight reports is eight reports, and that is the
      // workload the chart is about.
      unit: 'count',
      series: wanted.map(reason => ({
        key: reason,
        label: titleise(reason),
        points: layOn(
          buckets,
          rows.filter(row => row.reason === reason),
        ),
      })),
    };
  }

  private async reportsByTarget(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: SafetyFilters,
  ): Promise<BreakdownChart> {
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ key: string; total: bigint }>>`
        WITH ${this.pop(filter)}
        SELECT r."target_type"::text AS key, COUNT(*) AS total
        FROM "reports" r
        WHERE r."created_at" >= ${range.fromInstant} AND r."created_at" < ${range.toInstant}
          AND ${this.subject(Prisma.sql`r."target_user_id"`, extra)}
          ${this.reportScope(extra)}
        GROUP BY 1
      `,
    );

    return toBreakdown(rows, {
      unit: 'count',
      top: TARGET_ROWS,
      labels: new Map(Object.values(ReportTargetType).map(type => [type, titleise(type)])),
    });
  }

  /**
   * How long a case waited before anybody acted on it, by priority.
   *
   * §5.25's own definition, now that the table exists: `report_cases.first_action_at −
   * first_reported_at`, where first action is **claim or decision, whichever came first**, grouped
   * by the case's own `priority` and bucketed by the day it was decided.
   *
   * It used to read `moderation_queue_items.decided_at − created_at` and map the item's risk
   * *level* onto a priority, because `report_cases` did not exist. Two things were wrong with that
   * and both are now gone. It measured time-to-**decision** rather than time-to-action, so the
   * figure was an upper bound on the thing the SLA is set against; and `NORMAL` combined two risk
   * levels, so its value was the larger of two medians — a median of medians is not a median, and
   * the old code said so in a comment rather than being able to fix it. A case carries a real
   * priority, so each band is now one median over one population.
   *
   * Still a median rather than a mean, and still bucketed by the day of the decision: one case
   * that sat over Christmas would drag a mean past every real experience.
   */
  private async timeToAction(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: SafetyFilters,
  ): Promise<TimeSeriesChart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ priority: string; day: Date; minutes: number }>>`
        WITH ${this.pop(filter)}
        SELECT c."priority"::text AS priority,
               (c."decided_at" AT TIME ZONE 'Europe/London')::date AS day,
               PERCENTILE_CONT(0.5) WITHIN GROUP (
                 ORDER BY EXTRACT(EPOCH FROM (c."first_action_at" - c."first_reported_at")) / 60
               ) AS minutes
        FROM "report_cases" c
        WHERE c."decided_at" IS NOT NULL
          -- A decided case always has one, because deciding sets it. The guard is for the row that
          -- predates the column rather than for a case that was somehow decided without being
          -- touched: without it such a row contributes a NULL that PERCENTILE_CONT ignores, which
          -- is harmless, and a count that disagrees with decisionMix, which is not.
          AND c."first_action_at" IS NOT NULL
          AND c."decided_at" >= ${range.fromInstant} AND c."decided_at" < ${range.toInstant}
          AND ${this.subject(Prisma.sql`c."target_user_id"`, extra)}
          ${this.caseScope(extra)}
        GROUP BY 1, 2
      `,
    );

    const index = indexByDay(buckets);

    return {
      kind: 'timeseries',
      granularity: range.granularity,
      unit: 'minutes',
      series: PRIORITIES.map(priority => {
        const minutes = buckets.map(() => null as Num);

        for (const row of rows) {
          if (row.priority !== priority) continue;

          const position = index.get(dayKey(row.day));

          if (position !== undefined) minutes[position] = Math.round(Number(row.minutes));
        }

        return {
          key: priority,
          label: titleise(priority),
          points: buckets.map((bucket, position) => ({ t: bucket.key, v: minutes[position] })),
        };
      }),
    };
  }

  /**
   * How much was waiting at the end of each bucket, stacked by queue.
   *
   * §5.25 reads this from `moderation_backlog_daily`, a nightly snapshot that does not exist.
   * It does not need to: an item is open from the moment it is created until the moment it is
   * decided, so the backlog at any cut-off is everything created before it minus everything
   * decided before it. Derived that way the series is **exact** rather than a sample, and it
   * cannot drift away from the live queue the dashboard counts.
   *
   * The baseline matters. Without the count of what was already open at `from`, the first bucket
   * starts at whatever happened to arrive that day and the whole line reads low.
   */
  private async queueBacklog(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: SafetyFilters,
  ): Promise<TimeSeriesChart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);
    const [moves, baseline] = await Promise.all([
      this.runner.query(
        tx => tx.$queryRaw<Array<{ type: string; kind: string; day: Date; total: bigint }>>`
          WITH ${this.pop(filter)}
          SELECT q."type"::text AS type, 'opened' AS kind,
                 (q."created_at" AT TIME ZONE 'Europe/London')::date AS day, COUNT(*) AS total
          FROM "moderation_queue_items" q
          WHERE q."created_at" >= ${range.fromInstant} AND q."created_at" < ${range.toInstant}
            AND ${this.subject(Prisma.sql`q."subject_user_id"`, extra)}
            ${this.queueScope(extra)}
          GROUP BY 1, 2, 3
          UNION ALL
          SELECT q."type"::text AS type, 'closed' AS kind,
                 (q."decided_at" AT TIME ZONE 'Europe/London')::date AS day, COUNT(*) AS total
          FROM "moderation_queue_items" q
          WHERE q."decided_at" IS NOT NULL
            AND q."decided_at" >= ${range.fromInstant} AND q."decided_at" < ${range.toInstant}
            AND ${this.subject(Prisma.sql`q."subject_user_id"`, extra)}
            ${this.queueScope(extra)}
          GROUP BY 1, 2, 3
        `,
      ),
      this.runner.query(
        tx => tx.$queryRaw<Array<{ type: string; total: bigint }>>`
          WITH ${this.pop(filter)}
          SELECT q."type"::text AS type, COUNT(*) AS total
          FROM "moderation_queue_items" q
          WHERE q."created_at" < ${range.fromInstant}
            AND (q."decided_at" IS NULL OR q."decided_at" >= ${range.fromInstant})
            AND ${this.subject(Prisma.sql`q."subject_user_id"`, extra)}
            ${this.queueScope(extra)}
          GROUP BY 1
        `,
      ),
    ]);

    const before = new Map(baseline.map(row => [row.type, Number(row.total)]));
    // The same exclusion the queries carry, applied to the band list. Without it the chart grows a
    // permanently-flat `PROFESSIONAL_REVIEW` line, which reads as "none outstanding" to anybody
    // looking at it — a worse answer than not drawing the band at all, because a reviewer trusts a
    // zero. A type the queries do not count does not get a band.
    const charted = Object.values(ModerationQueueType).filter(
      type => !NOT_MODERATION.includes(type),
    );
    const wanted = extra.queueTypes?.length
      ? charted.filter(type => extra.queueTypes!.includes(type))
      : charted;

    return {
      kind: 'timeseries',
      granularity: range.granularity,
      unit: 'count',
      series: wanted.map(type => {
        const opened = layOn(
          buckets,
          moves.filter(row => row.type === type && row.kind === 'opened'),
        );
        const closed = layOn(
          buckets,
          moves.filter(row => row.type === type && row.kind === 'closed'),
        );
        let running = before.get(type) ?? 0;

        return {
          key: type,
          label: titleise(type),
          points: buckets.map((bucket, position) => {
            running += (opened[position].v ?? 0) - (closed[position].v ?? 0);

            return { t: bucket.key, v: running };
          }),
        };
      }),
    };
  }

  /**
   * What staff decided, strongest action first.
   *
   * §5.25's own source and its own five keys, now that both exist: `report_cases.decision`, with
   * `REMOVE_AND_WARN` and `REMOVE_AND_SUSPEND` folded under their strongest action. The fold is
   * done in SQL rather than afterwards, so the breakdown's `total` and its shares are over the
   * folded rows — add them up in JavaScript and the total is right while every share is computed
   * against a different denominator.
   *
   * It used to read `moderation_queue_items`, and its comment said there was nothing to fold
   * because `ModerationDecision` held no compound value. It holds three now — the two folded here
   * and `ESCALATE_GUARD` — which is the quiet way a chart goes wrong: nothing broke, a band simply
   * started existing and nobody was counting it.
   *
   * `CASE_DECISIONS` is the authority for the bands. A case can only be decided one of seven ways
   * and five survive the fold, so the chart's keys are exactly the values the column can hold
   * rather than a list somebody kept in step by hand.
   */
  private async decisionMix(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: SafetyFilters,
  ): Promise<BreakdownChart> {
    const folds = Object.entries(FOLDED_DECISION) as Array<
      [ModerationDecision, ModerationDecision]
    >;
    // `CASE WHEN … END` with no branches is a syntax error, so the folded column is only built
    // when there is something to fold. Not reachable today — `FOLDED_DECISION` has two entries —
    // and the point is that emptying it should give a chart with an extra band rather than a
    // five-hundred.
    const key = folds.length
      ? Prisma.sql`CASE ${Prisma.join(
          folds.map(
            ([from, to]) =>
              Prisma.sql`WHEN c."decision" = ${from}::"ModerationDecision" THEN ${to}`,
          ),
          ' ',
        )} ELSE c."decision"::text END`
      : Prisma.sql`c."decision"::text`;
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ key: string; total: bigint }>>`
        WITH ${this.pop(filter)}
        SELECT ${key} AS key, COUNT(*) AS total
        FROM "report_cases" c
        WHERE c."decision" IS NOT NULL
          AND c."decided_at" >= ${range.fromInstant} AND c."decided_at" < ${range.toInstant}
          AND ${this.subject(Prisma.sql`c."target_user_id"`, extra)}
          ${this.caseScope(extra)}
        GROUP BY 1
      `,
    );

    return toBreakdown(rows, {
      unit: 'count',
      order: [...DECISION_ORDER],
      labels: new Map(Object.values(ModerationDecision).map(value => [value, titleise(value)])),
    });
  }

  /**
   * What the scanner made of the content it saw, by severity and category.
   *
   * §5.25's own source, now that it exists: `content_safety`, one row per scanned item, with
   * `tier` for the rows and `category` for the columns, and `CLEAN` excluded because a scan that
   * found nothing is not a flag.
   *
   * This is a **wider** set than what it replaced. It used to read the queue items the scanner
   * raised, which is only the content that was held or limited — so the chart answered "what was
   * held and why" while its title said "what the scanner flagged", and a tier that never produces
   * an item was a permanently empty row. Reading the scan table means `LOW` finally has a
   * population, and the matrix says what the lexicon and the classifier are actually seeing.
   *
   * Bucketed by the scan, not by the content: an edit re-scans, and a post rewritten three times
   * is three readings of the lexicon. That is the right unit for a chart about the scanner.
   */
  private async flaggedByTierCategory(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: SafetyFilters,
  ): Promise<MatrixChart> {
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ row: string; col: string | null; total: bigint }>>`
        WITH ${this.pop(filter)}
        SELECT cs."tier"::text AS row, cs."category"::text AS col, COUNT(*) AS total
        FROM "content_safety" cs
        WHERE cs."tier" <> 'CLEAN'
          AND cs."created_at" >= ${range.fromInstant} AND cs."created_at" < ${range.toInstant}
          AND ${this.subject(Prisma.sql`cs."author_id"`, extra)}
          ${this.scanScope(extra)}
        GROUP BY 1, 2
      `,
    );

    return toMatrix(rows, {
      unit: 'count',
      rows: FLAGGED_TIERS.map(tier => ({ key: tier, label: titleise(tier) })),
      cols: [
        ...Object.values(RiskCategory).map(category => ({
          key: category,
          label: titleise(category),
        })),
        // `ContentSafety.category` is nullable and a flagged scan can have none: `categoryOf`
        // returns the lexicon's category, and that is null when the **classifier** is what raised
        // the score. There are no such rows today only because the classifier is switched off
        // (§6.7), so this column is empty now and stops being empty the day it ships.
        //
        // Without it `toMatrix` maps the null onto its own `UNKNOWN` key, finds no column of that
        // name and drops the cell — a flagged scan missing from a chart of flagged scans, with
        // nothing to say it was ever there. `guardCases` declares the same row for the same
        // reason.
        { key: 'UNKNOWN', label: 'Not categorised' },
      ],
    });
  }

  /**
   * Which phrases in the lexicon are earning their place.
   *
   * §5.25's own source, now that it exists: `risk_term_hits`, one row per phrase that matched,
   * with `outcome` saying whether a reviewer agreed. Joined to `risk_terms` **on its id**, so a
   * row can be acted on and a phrase that was edited keeps its own record.
   *
   * What this replaces was the most strained substitution on the tab. There was no hit log, so it
   * unnested `moderation_queue_items.risk_signals` — the matched phrases the scanner writes for
   * the reviewer — and joined back to `risk_terms` on `(category, pattern)`, inferring the outcome
   * from the *item's* decision. Three things were wrong with that and all three are now fixed:
   *
   *  - a hit on content that never became a queue item was invisible, so the phrases that fire
   *    most often on clean content — exactly the ones a reviewer wants to delete — were the ones
   *    least likely to appear;
   *  - the item's decision is about the item, not the phrase, so a post removed for one phrase
   *    confirmed every other phrase that happened to match it;
   *  - the join was on a pattern string, so editing a term's text orphaned its history.
   *
   * The false-positive rate is still taken over **resolved** hits only. Over all of them a fresh
   * term looks useless until somebody reviews it, which is precisely when a reviewer might delete
   * the term that was working.
   */
  private async topRiskTerms(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: SafetyFilters,
  ): Promise<TableChart> {
    const rows = await this.runner.query(
      tx => tx.$queryRaw<
        Array<{
          term_id: string;
          pattern: string;
          category: string;
          hits: bigint;
          confirmed: bigint;
          false_positives: bigint;
        }>
      >`
        WITH ${this.pop(filter)}
        SELECT rt."id" AS term_id, rt."pattern" AS pattern, rt."category"::text AS category,
               COUNT(*) AS hits,
               COUNT(CASE WHEN h."outcome" = 'CONFIRMED' THEN 1 END) AS confirmed,
               COUNT(CASE WHEN h."outcome" = 'FALSE_POSITIVE' THEN 1 END) AS false_positives
        FROM "risk_term_hits" h
        JOIN "risk_terms" rt ON rt."id" = h."risk_term_id"
        -- Left, not inner: a hit whose scan row has been cleaned up is still a hit, and dropping
        -- it would quietly shrink the counts on the oldest terms. The member filter below is what
        -- needs the join, and only when one is in force.
        LEFT JOIN "content_safety" cs ON cs."id" = h."content_safety_id"
        WHERE h."created_at" >= ${range.fromInstant} AND h."created_at" < ${range.toInstant}
          AND ${this.subject(Prisma.sql`cs."author_id"`, extra)}
          ${this.termScope(extra)}
        GROUP BY 1, 2, 3
        ORDER BY 4 DESC, 2 ASC
        LIMIT ${TERM_ROWS}
      `,
    );

    return {
      kind: 'table',
      // `termId` is **not** a column, and stays on the rows: the portal reads the first column as
      // the row's label, so declaring the id first drew a table of uuids where the phrases should
      // be. It is still on each row, because that is what the row links to.
      columns: [
        { key: 'pattern', label: 'Phrase' },
        { key: 'category', label: 'Category' },
        { key: 'hits', label: 'Hits', unit: 'count' },
        { key: 'confirmed', label: 'Confirmed', unit: 'count' },
        { key: 'falsePositives', label: 'False positives', unit: 'count' },
        { key: 'falsePositiveRate', label: 'False positive rate', unit: 'percent' },
      ],
      rows: rows.map(row => {
        const confirmed = Number(row.confirmed);
        const falsePositives = Number(row.false_positives);

        return {
          termId: row.term_id,
          pattern: row.pattern,
          category: titleise(row.category),
          hits: Number(row.hits),
          confirmed,
          falsePositives,
          falsePositiveRate: rate(falsePositives, confirmed + falsePositives),
        };
      }),
    };
  }

  /** Guard threads opened in the range, by what they were about and how serious it looked. */
  private async guardCases(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: SafetyFilters,
  ): Promise<MatrixChart> {
    const parts: Prisma.Sql[] = [];

    if (extra.riskLevels?.length) {
      parts.push(Prisma.sql`g."risk_level"::text IN (${Prisma.join(extra.riskLevels)})`);
    }

    if (extra.riskCategories?.length) {
      parts.push(Prisma.sql`g."risk_category"::text IN (${Prisma.join(extra.riskCategories)})`);
    }

    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ row: string | null; col: string; total: bigint }>>`
        WITH ${this.pop(filter)}
        SELECT g."risk_category"::text AS row, g."risk_level"::text AS col, COUNT(*) AS total
        FROM "guard_threads" g
        WHERE g."created_at" >= ${range.fromInstant} AND g."created_at" < ${range.toInstant}
          AND ${this.subject(Prisma.sql`g."user_id"`, extra)}
          ${parts.length ? Prisma.sql`AND ${Prisma.join(parts, ' AND ')}` : Prisma.empty}
        GROUP BY 1, 2
      `,
    );

    return toMatrix(rows, {
      // Threads, not members: one member can open several, and a thread is the unit of work.
      unit: 'count',
      rows: [
        ...Object.values(RiskCategory).map(category => ({
          key: category,
          label: titleise(category),
        })),
        // Guard threads carry no category until somebody triages them, and the untriaged ones are
        // the row a reader most needs to see.
        { key: 'UNKNOWN', label: 'Not categorised' },
      ],
      cols: Object.values(RiskLevel).map(level => ({ key: level, label: titleise(level) })),
    });
  }

  /**
   * How often a member argued with a decision and won.
   *
   * The one chart on this tab that was a `NOT_AVAILABLE_YET` slot, because §5.11's appeals had no
   * table. They have one, so this is now the measure §5.25 asks for: `OVERTURNED ÷ decided`, as a
   * headline and a trend.
   *
   * **Decided means decided.** `UPHELD` and `OVERTURNED` only — an appeal still open has no
   * outcome, and a `WITHDRAWN` one is the member changing their mind, which is theirs to do and
   * says nothing about whether the original decision was right. Counting either in the
   * denominator would push the rate down, and the direction matters: this number existing to catch
   * a reviewer being wrong too often is precisely why it must not be flattered.
   *
   * Bucketed by the day the appeal was **decided**, not raised, so a month's figure is the
   * decisions taken in it. Null where nothing was decided in a bucket rather than zero: no
   * appeals answered is not a 0% overturn rate, and a line that drops to the floor on a quiet week
   * reads as a run of good decisions.
   */
  private async appealOverturn(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: SafetyFilters,
  ): Promise<Chart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ day: Date; decided: bigint; overturned: bigint }>>`
        WITH ${this.pop(filter)}
        SELECT (a."decided_at" AT TIME ZONE 'Europe/London')::date AS day,
               COUNT(*) AS decided,
               COUNT(CASE WHEN a."state" = 'OVERTURNED' THEN 1 END) AS overturned
        FROM "appeals" a
        WHERE a."decided_at" IS NOT NULL
          AND a."state"::text IN (${Prisma.join([...APPEAL_OUTCOMES])})
          AND a."decided_at" >= ${range.fromInstant} AND a."decided_at" < ${range.toInstant}
          AND ${this.subject(Prisma.sql`a."user_id"`, extra)}
        GROUP BY 1
      `,
    );

    const index = indexByDay(buckets);
    const decided = buckets.map(() => 0);
    const overturned = buckets.map(() => 0);

    for (const row of rows) {
      const position = index.get(dayKey(row.day));

      if (position === undefined) continue;

      decided[position] += Number(row.decided);
      overturned[position] += Number(row.overturned);
    }

    const totalDecided = decided.reduce((sum, value) => sum + value, 0);
    const totalOverturned = overturned.reduce((sum, value) => sum + value, 0);
    const trend: Point[] = buckets.map((bucket, position) => ({
      t: bucket.key,
      v: rate(overturned[position], decided[position]),
    }));

    return {
      kind: 'group',
      items: {
        rate: {
          kind: 'kpi',
          value: rate(totalOverturned, totalDecided),
          // No previous period. The rate over a handful of appeals swings between 0 and 100 on one
          // decision, so a change percentage against last month would be noise presented as a
          // trend — and this is a number somebody would act on. The trend beside it is the honest
          // form of the same comparison.
          previous: null,
          changePct: null,
          unit: 'percent',
          sparkline: trend,
        },
        trend: {
          kind: 'timeseries',
          granularity: range.granularity,
          unit: 'percent',
          series: [{ key: 'overturnRate', label: 'Overturned', points: trend }],
        },
      },
    };
  }

  /**
   * How many members are suspended, as of the end of the range.
   *
   * "As of", not "in the range": a suspension issued last year and still in force is a current
   * fact about the platform, and a chart of suspensions *started* in March would read as though
   * nobody was suspended in a quiet month. The sparkline is the same measure at each bucket's end,
   * so the line is a level rather than a rate.
   */
  private async activeSuspensions(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
  ): Promise<KpiChart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);
    const cuts = [...buckets.map(bucket => bucket.to), range.toInstant];
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ position: number; total: bigint }>>`
        WITH ${this.pop(filter)},
        cuts AS (
          SELECT * FROM (VALUES ${Prisma.join(
            cuts.map((cut, position) => Prisma.sql`(${position}::int, ${cut}::timestamptz)`),
          )}) AS c(position, cut)
        )
        SELECT cuts."position" AS position, COUNT(s."id") AS total
        FROM cuts
        LEFT JOIN "suspensions" s
          ON s."starts_at" < cuts."cut"
         AND (s."ends_at" IS NULL OR s."ends_at" > cuts."cut")
         AND (s."lifted_at" IS NULL OR s."lifted_at" > cuts."cut")
         AND EXISTS (SELECT 1 FROM pop WHERE pop."user_id" = s."user_id")
        GROUP BY 1
      `,
    );

    const byPosition = new Map(rows.map(row => [Number(row.position), Number(row.total)]));
    const value = byPosition.get(cuts.length - 1) ?? 0;

    return {
      kind: 'kpi',
      value,
      // No comparison: "suspended as of a date" has no previous-period equivalent that is not
      // misleading — the previous period's end is simply an earlier point on the same line, which
      // the sparkline already shows.
      previous: null,
      changePct: null,
      // Members, so the sparkline's small numbers are withheld (§2.7). The headline is not, for
      // the reason set out in `suppression.ts`: it is an aggregate the population floor has
      // already judged.
      unit: 'members',
      sparkline: buckets.map((bucket, position) => ({
        t: bucket.key,
        v: byPosition.get(position) ?? 0,
      })),
    };
  }
}

const rate = (part: number, whole: number): Num =>
  whole > 0 ? Math.round((part / whole) * 10_000) / 100 : null;

const titleise = (code: string): string =>
  code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, ' ');

const dayKey = (day: Date): string => day.toISOString().slice(0, 10);

const layOn = (buckets: Bucket[], rows: Array<{ day: Date; total: bigint }>): Point[] => {
  const index = indexByDay(buckets);
  const totals = buckets.map(() => 0);

  for (const row of rows) {
    const position = index.get(dayKey(row.day));

    if (position !== undefined) totals[position] += Number(row.total);
  }

  return buckets.map((bucket, position) => ({ t: bucket.key, v: totals[position] }));
};
