import { Injectable } from '@nestjs/common';
import {
  ModerationDecision,
  ModerationQueueState,
  ModerationQueueType,
  Prisma,
  ReportCasePriority,
  ReportCaseState,
  ReportReason,
  ReportState,
  ReportTargetType,
  ContentRiskTier,
  RiskLevel,
} from '@prisma/client';
import { SYSTEM_CONFIG_KEYS, toJson } from '@/common';
import { SystemConfigService } from '@/modules/platform/shared';
import {
  DISMISSAL_STANDS_DAYS,
  LIVE_CASE_STATES,
  REOPEN_AFTER_NEW_REPORTERS,
  dueBy,
  priorityFor,
  raisedTo,
} from './report-priority';

type Tx = Prisma.TransactionClient;

export interface IntakeInput {
  reportId: string;
  reporterId: string;
  reasonCode: ReportReason;
  targetType: ReportTargetType;
  targetId: string;
  /** The reported member, where the target has one. */
  targetUserId: string | null;
  /** Whether the content has already been taken down, which is what makes a decision final. */
  targetRemoved: boolean;
  /** The scanner's verdict on the content, which decides the priority with the reason (§7.1). */
  tier: ContentRiskTier;
  riskLevel: RiskLevel;
  riskScore: number;
  riskSignals?: unknown;
  summary: string | null;
  /** SAFETY_CONCERN and urgent risk still route to Guard as well as opening a case (§7.1 step 6). */
  guard: boolean;
}

export interface IntakeResult {
  caseId: string;
  /**
   * Null where nothing was prioritised: `ModerationService.report` answers with the case a
   * duplicate report already belongs to, and that case's priority was not recomputed.
   *
   * Declared nullable because nothing else will catch it — this project compiles with
   * `strictNullChecks: false`, so a null in a non-nullable slot is silent. The type is the only
   * warning a reader gets.
   */
  priority: ReportCasePriority | null;
  /**
   * Set when the report was answered without a reviewer: the same target was decided, the content
   * is gone, and the answer is already known. The reporter is told the outcome (§7.3) and no new
   * work is created.
   */
  settled: ModerationDecision | null;
  /** True when the report was filed against a dismissal that still stands (§7.1 step 5). */
  late: boolean;
}

/**
 * §7.1's grouping: reports are the evidence, a case is the job.
 *
 * Three people reporting one post is one thing for a reviewer to read and one answer for all
 * three, which is what this turns a stream of reports into. It also fixes the lost-report bug §9
 * describes — a report filed on content that was already dealt with used to create an item nobody
 * could act on, and now it either joins the open case or is answered from the decided one.
 *
 * Everything here runs inside the caller's transaction, because a report that exists without its
 * case is a report nobody will ever see.
 */
@Injectable()
export class ReportCaseService {
  constructor(private readonly config: SystemConfigService) {}

  async intake(tx: Tx, input: IntakeInput): Promise<IntakeResult> {
    const sla = await this.config.get(SYSTEM_CONFIG_KEYS.REPORT_SLA_MINUTES);
    const priority = priorityFor(input.reasonCode, input.tier);
    const now = new Date();

    const open = await tx.reportCase.findFirst({
      where: {
        targetType: input.targetType,
        targetId: input.targetId,
        state: { in: [...LIVE_CASE_STATES] },
      },
    });

    if (open) return this.join(tx, open, input, priority, sla, now);

    const latest = await tx.reportCase.findFirst({
      where: { targetType: input.targetType, targetId: input.targetId },
      orderBy: { createdAt: 'desc' },
    });

    // §7.1 step 5, the first half: the same target was actioned and the content is gone. The
    // answer to this report is the answer that was already given, so the reporter is told it
    // rather than waiting behind a case nobody needs to open.
    if (latest?.state === ReportCaseState.ACTIONED && input.targetRemoved) {
      await this.join(tx, latest, input, priority, sla, now, { reopen: false });
      await tx.report.update({
        where: { id: input.reportId },
        data: {
          state: ReportState.ACTIONED,
          decision: latest.decision,
          decisionNote: 'Already actioned: the content was removed.',
          reviewedAt: now,
        },
      });

      return {
        caseId: latest.id,
        priority: latest.priority,
        settled: latest.decision,
        late: false,
      };
    }

    // The second half: a dismissal stands for a week unless this report is urgent or a second new
    // person has come forward. Otherwise it is attached to the dismissed case as a late report,
    // where a reviewer can see it without it reopening the argument by itself.
    if (latest?.state === ReportCaseState.DISMISSED && this.standsStill(latest.decidedAt, now)) {
      const fresh = await this.newReportersSince(tx, latest.id, latest.decidedAt, input.reporterId);

      if (priority !== ReportCasePriority.URGENT && fresh < REOPEN_AFTER_NEW_REPORTERS) {
        await this.join(tx, latest, input, priority, sla, now, { reopen: false });

        return { caseId: latest.id, priority: latest.priority, settled: null, late: true };
      }
    }

    return this.open(tx, input, priority, sla, now);
  }

  /** A report joining a case that already exists (§7.1 step 4). */
  private async join(
    tx: Tx,
    existing: {
      id: string;
      priority: ReportCasePriority;
      state: ReportCaseState;
      firstReportedAt: Date;
      reasonCodes: ReportReason[];
      riskLevel: RiskLevel;
      riskScore: number;
    },
    input: IntakeInput,
    priority: ReportCasePriority,
    sla: Record<string, number>,
    now: Date,
    options: { reopen?: boolean } = {},
  ): Promise<IntakeResult> {
    await tx.report.update({ where: { id: input.reportId }, data: { caseId: existing.id } });

    const reports = await tx.report.findMany({
      where: { caseId: existing.id },
      select: { reporterId: true },
    });
    const live = options.reopen !== false;
    // Raise only (§7.1): a case that was urgent does not become ordinary because the fourth
    // person to report it picked a milder reason. A decided case keeps the priority it was
    // decided at — there is no SLA left to miss.
    const raised = live ? raisedTo(existing.priority, priority) : existing.priority;

    await tx.reportCase.update({
      where: { id: existing.id },
      data: {
        reportCount: reports.length,
        uniqueReporterCount: new Set(reports.map(report => report.reporterId)).size,
        reasonCodes: [...new Set([...existing.reasonCodes, input.reasonCode])],
        lastReportedAt: now,
        ...(live
          ? {
              priority: raised,
              dueAt: dueBy(existing.firstReportedAt, raised, sla),
              riskLevel: this.higherLevel(existing.riskLevel, input.riskLevel),
              riskScore: Math.max(existing.riskScore, input.riskScore),
            }
          : {}),
      },
    });

    if (live) {
      await this.attachQueueItem(
        tx,
        existing.id,
        input,
        raised,
        dueBy(existing.firstReportedAt, raised, sla),
      );
    }

    return { caseId: existing.id, priority: raised, settled: null, late: false };
  }

  /** The first report about this target, or the first since the last one was decided. */
  private async open(
    tx: Tx,
    input: IntakeInput,
    priority: ReportCasePriority,
    sla: Record<string, number>,
    now: Date,
  ): Promise<IntakeResult> {
    const created = await tx.reportCase.create({
      data: {
        targetType: input.targetType,
        targetId: input.targetId,
        targetUserId: input.targetUserId,
        priority,
        reasonCodes: [input.reasonCode],
        riskLevel: input.riskLevel,
        riskScore: input.riskScore,
        firstReportedAt: now,
        lastReportedAt: now,
        dueAt: dueBy(now, priority, sla),
      },
    });

    await tx.report.update({ where: { id: input.reportId }, data: { caseId: created.id } });
    await this.attachQueueItem(tx, created.id, input, priority, dueBy(now, priority, sla));

    return { caseId: created.id, priority, settled: null, late: false };
  }

  /**
   * The reviewer's way in. One item per `(type, target)` is the queue's own unique key, so a
   * repeat report updates the item rather than stacking them up.
   *
   * The item may already belong to a **decided** case, because the key has no case in it: the
   * second argument about one post reuses the row from the first. So the link is moved rather
   * than duplicated — `ReportCase.queueItemId` is unique, and two cases claiming one item is a
   * write that would simply fail.
   */
  private async attachQueueItem(
    tx: Tx,
    caseId: string,
    input: IntakeInput,
    priority: ReportCasePriority,
    dueAt: Date,
  ): Promise<void> {
    const type = input.guard
      ? ModerationQueueType.GUARD_RISK
      : ModerationQueueType.REPORTED_CONTENT;
    const item = await tx.moderationQueueItem.upsert({
      where: {
        type_targetType_targetId: {
          type,
          targetType: input.targetType,
          targetId: input.targetId,
        },
      },
      update: {
        // A second report on the same content raises its score rather than creating a second row.
        riskScore: { increment: Math.max(10, input.riskScore) },
        ...(input.riskLevel !== RiskLevel.NONE ? { riskLevel: input.riskLevel } : {}),
        // Back on the pile: the previous argument about this post was decided, and this is a new
        // one. Without this, a reviewer would never see the second report at all — which is the
        // lost-report bug §9 names.
        state: ModerationQueueState.PENDING,
        decision: null,
        decisionNote: null,
        decidedById: null,
        decidedAt: null,
        reportId: input.reportId,
      },
      create: {
        type,
        targetType: input.targetType,
        targetId: input.targetId,
        subjectUserId: input.targetUserId,
        // The **case's** priority and deadline, not a second opinion. The case is the thing with
        // the SLA on it; a queue item that computed its own would be a row disagreeing with the
        // detail page it links to.
        priority,
        dueAt,
        reportId: input.reportId,
        riskLevel: input.riskLevel,
        riskScore: Math.max(10, input.riskScore),
        riskSignals: toJson(input.riskSignals ?? []),
        summary: input.summary,
      },
      select: { id: true },
    });

    await tx.reportCase.updateMany({
      where: { queueItemId: item.id, NOT: { id: caseId } },
      data: { queueItemId: null },
    });

    // The first item opened for a case stays its way in. A safeguarding report on a post that
    // already has a case raises a `GUARD_RISK` item *as well* (§7.1 step 6) — two pieces of work,
    // because Guard answers a different question — and moving the link to whichever report
    // arrived last would make a reviewer's route into the case depend on the order people
    // happened to tap in.
    const current = await tx.reportCase.findUnique({
      where: { id: caseId },
      select: { queueItemId: true },
    });

    await tx.reportCase.update({
      where: { id: caseId },
      data: { ...(current?.queueItemId ? {} : { queueItemId: item.id }), priority },
    });
  }

  /** Whether a dismissal is still young enough to stand (§7.1 step 5). */
  private standsStill(decidedAt: Date | null, now: Date): boolean {
    if (!decidedAt) return false;

    return now.getTime() - decidedAt.getTime() < DISMISSAL_STANDS_DAYS * 86_400_000;
  }

  /** How many people have reported this target since it was dismissed, counting this one. */
  private async newReportersSince(
    tx: Tx,
    caseId: string,
    decidedAt: Date | null,
    reporterId: string,
  ): Promise<number> {
    if (!decidedAt) return 0;

    const since = await tx.report.findMany({
      where: { caseId, createdAt: { gt: decidedAt } },
      select: { reporterId: true },
    });

    return new Set([...since.map(report => report.reporterId), reporterId]).size;
  }

  private higherLevel(current: RiskLevel, next: RiskLevel): RiskLevel {
    const rank: Record<RiskLevel, number> = {
      [RiskLevel.NONE]: 0,
      [RiskLevel.LOW]: 1,
      [RiskLevel.MEDIUM]: 2,
      [RiskLevel.HIGH]: 3,
      [RiskLevel.CRITICAL]: 4,
    };

    return rank[next] > rank[current] ? next : current;
  }
}
