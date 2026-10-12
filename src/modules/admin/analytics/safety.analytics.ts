import { Injectable } from '@nestjs/common';
import {
  ModerationDecision,
  ModerationQueueType,
  Prisma,
  ReportReason,
  ReportTargetType,
  RiskCategory,
  RiskLevel,
} from '@prisma/client';
import { ApiErrorCode } from '@/common';
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

/**
 * The risk levels this tab charts, and the three buckets `timeToAction` reports.
 *
 * `NONE` is excluded from the flagged matrix: a scan that found nothing is not a flag, and a
 * column of them would dwarf every real one.
 */
const FLAGGED_LEVELS = [
  RiskLevel.LOW,
  RiskLevel.MEDIUM,
  RiskLevel.HIGH,
  RiskLevel.CRITICAL,
] as const;

/**
 * How a risk level becomes a response-time bucket.
 *
 * §5.25 asks for `URGENT`, `HIGH` and `NORMAL`, which are priorities rather than levels — the
 * mapping is the one the dashboard already uses when it calls `CRITICAL` scans urgent.
 */
const PRIORITY_OF: Record<RiskLevel, 'URGENT' | 'HIGH' | 'NORMAL'> = {
  [RiskLevel.CRITICAL]: 'URGENT',
  [RiskLevel.HIGH]: 'HIGH',
  [RiskLevel.MEDIUM]: 'NORMAL',
  [RiskLevel.LOW]: 'NORMAL',
  [RiskLevel.NONE]: 'NORMAL',
};

const PRIORITIES = ['URGENT', 'HIGH', 'NORMAL'] as const;

/**
 * Queue types this tab must never count.
 *
 * `PROFESSIONAL_REVIEW` (§2.9) shares the queue table and is not moderation work: it is an
 * approval for somebody who wants to offer a regulated service, with its own endpoint, its own two
 * verbs and no accusation attached. Counting it among decided moderation items makes every figure
 * on this tab wrong in a way that looks like the platform got slower.
 */
const NOT_MODERATION: readonly string[] = ['PROFESSIONAL_REVIEW'];

/**
 * Which decisions count as the term having been right, and which as a false positive.
 *
 * An undecided item is neither. Counting it as a false positive would make every fresh term look
 * useless, and counting it as confirmed would make every term look infallible — the rate is only
 * meaningful over the items somebody actually looked at.
 */
const CONFIRMING = [
  ModerationDecision.REMOVE_CONTENT,
  ModerationDecision.WARN_AUTHOR,
  ModerationDecision.SUSPEND_AUTHOR,
  ModerationDecision.REJECT,
] as const;

const EXONERATING = [ModerationDecision.APPROVE, ModerationDecision.NO_ACTION] as const;

/** The decision mix, strongest action first, so the bar reads as a severity scale. */
const DECISION_ORDER = [
  ModerationDecision.SUSPEND_AUTHOR,
  ModerationDecision.REMOVE_CONTENT,
  ModerationDecision.WARN_AUTHOR,
  ModerationDecision.REJECT,
  ModerationDecision.APPROVE,
  ModerationDecision.NO_ACTION,
] as const;

/**
 * Trust & Safety (§5.25).
 *
 * Nine of the tab's ten charts, and the tenth says why it is missing. The spec sources this tab
 * from tables the safety milestone has not built yet — `report_cases`, `moderation_backlog_daily`,
 * `content_safety`, `risk_term_hits`, appeals — so every chart here is sourced from what the
 * schema actually holds, and each substitution is recorded in §12 of the spec rather than left for
 * a reader to discover from a number that does not match.
 *
 * The one chart with no source at all is `appealOverturn`: there is no appeal table, in any shape.
 * It returns `{ kind: 'error', code: 'NOT_AVAILABLE_YET' }`, which §5.25 names for exactly this —
 * a slot the portal can render as "coming soon" rather than an empty chart it cannot tell apart
 * from a quiet month.
 */
@Injectable()
export class SafetyAnalytics {
  constructor(private readonly runner: AnalyticsRunnerService) {}

  static readonly FILTER_SEMANTICS: Record<string, string> = {
    memberFilters:
      'narrow by the **reported or authoring** member, not the reporter. A report whose subject ' +
      'cannot be resolved to a member is therefore excluded whenever a member filter is in force, ' +
      'and counted when none is.',
    states: 'report states (`ReportState`); the moderation queue is filtered by `queueTypes`.',
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
      appealOverturn: () => this.appealOverturn(),
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

  /** The queue filters. A queue item has a type and a risk, and no reason code. */
  private queueScope(extra: SafetyFilters): Prisma.Sql {
    // Always, before any caller's filter: the types on this table that are **not** moderation.
    //
    // Every chart on this tab answers a question about risk — how fast we act on it, how much is
    // waiting, whether the lexicon was right. A `PROFESSIONAL_REVIEW` item is none of that: nothing
    // is wrong with the listing and nobody is accused of anything, it is an onboarding approval
    // that happens to live in the same table because it needs a reviewer and a queue.
    //
    // Charted together, three approved listings put a 384-minute median on the NORMAL line and the
    // "time to action" figure stopped being about action on risk at all. The exclusion is here, in
    // the one fragment all eight queries pass through, rather than in each of them: added to §5.9's
    // own default-tab list and forgotten here, it would have been wrong in exactly this invisible
    // way — a number that is plausible, moves for the wrong reasons, and nobody checks.
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
   * How long a flagged item waited for a decision, by priority.
   *
   * §5.25 defines this as `first_action_at − first_reported_at`, "claim or decision, whichever
   * first". Nothing records a claim: `ModerationQueueItem` has an assignee but no timestamp for
   * when they took it, so the only knowable first action is the decision. That makes this number
   * an **upper bound** on time-to-action rather than the figure the spec describes, which is worth
   * knowing before anybody sets a target against it.
   *
   * A median rather than a mean, and bucketed by the day of the decision — one item that sat for
   * three weeks over Christmas would otherwise drag a mean past every real experience.
   */
  private async timeToAction(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: SafetyFilters,
  ): Promise<TimeSeriesChart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ level: string; day: Date; minutes: number }>>`
        WITH ${this.pop(filter)}
        SELECT q."risk_level"::text AS level,
               (q."decided_at" AT TIME ZONE 'Europe/London')::date AS day,
               PERCENTILE_CONT(0.5) WITHIN GROUP (
                 ORDER BY EXTRACT(EPOCH FROM (q."decided_at" - q."created_at")) / 60
               ) AS minutes
        FROM "moderation_queue_items" q
        WHERE q."decided_at" IS NOT NULL
          AND q."decided_at" >= ${range.fromInstant} AND q."decided_at" < ${range.toInstant}
          AND ${this.subject(Prisma.sql`q."subject_user_id"`, extra)}
          ${this.queueScope(extra)}
        GROUP BY 1, 2
      `,
    );

    const index = indexByDay(buckets);

    return {
      kind: 'timeseries',
      granularity: range.granularity,
      unit: 'minutes',
      series: PRIORITIES.map(priority => {
        // A median of medians is not a median, so the bucket's value is the median of the levels
        // that map to this priority weighted by nothing — with `URGENT` and `HIGH` each coming from
        // a single level, only `NORMAL` combines two, and taking the larger of them keeps the line
        // an upper bound rather than inventing an average of two medians.
        const worst = buckets.map(() => null as Num);

        for (const row of rows) {
          if (PRIORITY_OF[row.level as RiskLevel] !== priority) continue;

          const position = index.get(dayKey(row.day));

          if (position === undefined) continue;

          const minutes = Math.round(Number(row.minutes));

          worst[position] = Math.max(worst[position] ?? 0, minutes);
        }

        return {
          key: priority,
          label: titleise(priority),
          points: buckets.map((bucket, position) => ({ t: bucket.key, v: worst[position] })),
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
   * §5.25 keys this on `NO_ACTION`, `REMOVE_CONTENT`, `WARN_AUTHOR`, `SUSPEND_AUTHOR` and
   * `ESCALATE_GUARD`, and folds `REMOVE_AND_*` under "their strongest action". `ModerationDecision`
   * holds neither `ESCALATE_GUARD` nor any compound value, so there is nothing to fold — and it
   * holds `APPROVE` and `REJECT`, which the spec's list omits. Keyed on the enum as it exists,
   * because a bar chart whose keys are not the values in the column is a chart that silently drops
   * decisions.
   */
  private async decisionMix(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: SafetyFilters,
  ): Promise<BreakdownChart> {
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ key: string; total: bigint }>>`
        WITH ${this.pop(filter)}
        SELECT q."decision"::text AS key, COUNT(*) AS total
        FROM "moderation_queue_items" q
        WHERE q."decision" IS NOT NULL
          AND q."decided_at" >= ${range.fromInstant} AND q."decided_at" < ${range.toInstant}
          AND ${this.subject(Prisma.sql`q."subject_user_id"`, extra)}
          ${this.queueScope(extra)}
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
   * What the scanner held, by severity and category.
   *
   * §5.25 reads this from `content_safety`, the per-scan table, which does not exist — so this is
   * the **queue items** the scanner raised, which is a narrower set: a scan that found nothing
   * never becomes an item. The chart therefore answers "what was held and why" rather than "what
   * the scanner saw", and `NONE` is excluded because an item with no risk is not a flag.
   */
  private async flaggedByTierCategory(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: SafetyFilters,
  ): Promise<MatrixChart> {
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ row: string; col: string | null; total: bigint }>>`
        WITH ${this.pop(filter)}
        SELECT q."risk_level"::text AS row, q."risk_category"::text AS col, COUNT(*) AS total
        FROM "moderation_queue_items" q
        WHERE q."risk_level" <> 'NONE'
          AND q."created_at" >= ${range.fromInstant} AND q."created_at" < ${range.toInstant}
          AND ${this.subject(Prisma.sql`q."subject_user_id"`, extra)}
          ${this.queueScope(extra)}
        GROUP BY 1, 2
      `,
    );

    return toMatrix(rows, {
      unit: 'count',
      rows: FLAGGED_LEVELS.map(level => ({ key: level, label: titleise(level) })),
      cols: Object.values(RiskCategory).map(category => ({
        key: category,
        label: titleise(category),
      })),
    });
  }

  /**
   * Which phrases in the lexicon are earning their place.
   *
   * §5.25 reads this from `risk_term_hits`, which does not exist — but the hits do: the scanner
   * writes the matched phrases into `moderation_queue_items.risk_signals` as
   * `[{ category, pattern, weight }]`, "matched terms, for the reviewer". Unnested, that is the
   * hit log, and the item's own decision says whether the term was right.
   *
   * The false-positive rate is taken over **decided** items only. Over all items a fresh term
   * looks useless until somebody reviews it, which is precisely when a reviewer might delete the
   * term that was working.
   *
   * Joined back to `risk_terms` on `(category, pattern)` — its unique key — so a row carries the
   * term's id and can be acted on, and so a phrase deactivated and replaced keeps its own record.
   */
  private async topRiskTerms(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: SafetyFilters,
  ): Promise<TableChart> {
    const rows = await this.runner.query(
      tx => tx.$queryRaw<
        Array<{
          term_id: string | null;
          pattern: string;
          category: string;
          hits: bigint;
          confirmed: bigint;
          false_positives: bigint;
        }>
      >`
        WITH ${this.pop(filter)},
        hits AS (
          SELECT signal->>'pattern' AS pattern, signal->>'category' AS category, q."decision"
          FROM "moderation_queue_items" q
          -- The guard is on the INPUT, not in the WHERE. jsonb_array_elements raises "cannot
          -- extract elements from an object" on anything that is not an array, and a WHERE clause
          -- only saves the query while the planner happens to push the qual below the lateral --
          -- which it does today and need not tomorrow. The scanner writes an array or nothing, so
          -- this is latent rather than live, and a latent error in a chart is the kind that fires
          -- months later under a plan nobody changed on purpose.
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(q."risk_signals") = 'array'
                 THEN q."risk_signals" ELSE '[]'::jsonb END
          ) AS signal
          WHERE q."created_at" >= ${range.fromInstant} AND q."created_at" < ${range.toInstant}
            AND ${this.subject(Prisma.sql`q."subject_user_id"`, extra)}
            ${this.queueScope(extra)}
        )
        SELECT rt."id" AS term_id, hits."pattern" AS pattern, hits."category" AS category,
               COUNT(*) AS hits,
               COUNT(CASE WHEN hits."decision"::text
                 IN (${Prisma.join(CONFIRMING)}) THEN 1 END) AS confirmed,
               COUNT(CASE WHEN hits."decision"::text
                 IN (${Prisma.join(EXONERATING)}) THEN 1 END) AS false_positives
        FROM hits
        LEFT JOIN "risk_terms" rt
          ON rt."pattern" = hits."pattern" AND rt."category"::text = hits."category"
        WHERE hits."pattern" IS NOT NULL AND hits."category" IS NOT NULL
        GROUP BY 1, 2, 3
        ORDER BY 4 DESC, 2 ASC
        LIMIT ${TERM_ROWS}
      `,
    );

    return {
      kind: 'table',
      columns: [
        { key: 'termId', label: 'Term' },
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
   * Appeals: no table, in any shape.
   *
   * Returned as a chart-level error rather than omitted from the payload, so the portal renders
   * the slot the page was designed with and says what it is waiting for. An omitted chart looks
   * like a bug in the portal; an empty one looks like a quiet month.
   */
  private async appealOverturn(): Promise<Chart> {
    return {
      kind: 'error',
      code: ApiErrorCode.NOT_AVAILABLE_YET,
      message: 'Appeals are not recorded yet, so there is nothing to overturn.',
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
