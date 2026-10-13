import { Injectable, Logger } from '@nestjs/common';
import {
  AdminReasonCode,
  ContentVisibilityState,
  EnforcementSourceType,
  GuardCaseSource,
  ModerationDecision,
  ModerationQueueState,
  Prisma,
  ReportCasePriority,
  ReportCaseState,
  ReportState,
  ReportTargetType,
  RiskCategory,
} from '@prisma/client';
import { ApiErrorCode, ApiException, buildPageMeta } from '@/common';
import { PrismaService } from '@/infrastructure';
import { CONTENT_SOURCE, ContentSafetyService, MediaService } from '@/modules/platform/shared';
import { AuditService } from '../audit/audit.service';
import { AdminContentService } from '../content/admin-content.service';
import { AdminAppealService } from './admin-appeal.service';
import { AdminHistoryService } from './admin-history.service';
import { AdminGuardService, GUARD_ESCALATION_SUBJECT } from './admin-guard.service';
import { AdminPrincipal } from '../common/admin-principal';
import {
  AssignCaseDto,
  CaseDecisionDto,
  ListReportCasesDto,
  ListReportsDto,
} from '../dtos/admin-report-case.dto';
import { ReasonOnlyDto } from '../dtos/admin-member-actions.dto';
import {
  CaseTargetView,
  caseMemberSelect,
  toCaseDetail,
  toCaseRow,
  toReportRow,
} from '../serializers/admin-report-case.serializer';
import { staffRefSelect } from '../serializers/admin-staff.serializer';
import { AdminEnforcementService } from './admin-enforcement.service';
import { AdminMemberActionService } from './admin-member-action.service';
import { AdminModerationService } from './admin-moderation.service';

/** The states a case is still work in (§7.2). */
const LIVE: ReportCaseState[] = [ReportCaseState.OPEN, ReportCaseState.IN_REVIEW];

/** §5.10: a decided case can be reopened for thirty days, and then it stands. */
const REOPEN_WINDOW_DAYS = 30;

/** The decisions that take the content down. */
const REMOVES: ModerationDecision[] = [
  ModerationDecision.REMOVE_CONTENT,
  ModerationDecision.REMOVE_AND_WARN,
  ModerationDecision.REMOVE_AND_SUSPEND,
];

const ROW_SELECT = {
  id: true,
  targetType: true,
  targetId: true,
  priority: true,
  state: true,
  reasonCodes: true,
  reportCount: true,
  uniqueReporterCount: true,
  riskLevel: true,
  riskScore: true,
  dueAt: true,
  firstReportedAt: true,
  lastReportedAt: true,
  decidedAt: true,
  decision: true,
  decisionNote: true,
  claimedAt: true,
  reopenedAt: true,
  queueItemId: true,
  assignedToId: true,
  targetUserId: true,
  targetUser: { select: caseMemberSelect },
  assignedTo: { select: staffRefSelect },
} satisfies Prisma.ReportCaseSelect;

/**
 * §5.10: the screen a reviewer works a report case from, and §7.2's state machine underneath it.
 *
 * The decision is the only part with teeth. Everything a decision does to a member — a strike, a
 * suspension, the message they get — is delegated to `AdminMemberActionService`, which already
 * does it for the member screens: one implementation, one audit shape, and the enforcement source
 * fields (`REPORT_CASE` and the case id) are what let a member's history say *why* rather than
 * "manual". Taking content down goes through `AdminModerationService.removeContent` for the same
 * reason — that switch knows how each kind of thing comes down, and a second copy would drift.
 */
@Injectable()
export class AdminReportCaseService {
  private readonly logger = new Logger(AdminReportCaseService.name);

  constructor(
    private readonly database: PrismaService,
    private readonly media: MediaService,
    private readonly safety: ContentSafetyService,
    private readonly moderation: AdminModerationService,
    private readonly actions: AdminMemberActionService,
    private readonly audit: AuditService,
    private readonly enforcement: AdminEnforcementService,
    private readonly history: AdminHistoryService,
    private readonly guard: AdminGuardService,
    private readonly content: AdminContentService,
    private readonly appeals: AdminAppealService,
  ) {}

  async list(actor: AdminPrincipal, query: ListReportCasesDto) {
    const now = new Date();
    // Overdue only means anything about a case somebody could still act on, so it narrows the
    // states rather than sitting beside them. Spread as a second `state` key it would have
    // *replaced* the caller's filter, and `?overdue=true&state=ACTIONED` would have quietly
    // answered with open work instead.
    const asked = query.state?.length ? query.state : LIVE;
    const states = query.overdue ? asked.filter(state => LIVE.includes(state)) : asked;
    const where: Prisma.ReportCaseWhereInput = {
      state: { in: states },
      ...(query.priority?.length ? { priority: { in: query.priority } } : {}),
      ...(query.reasonCodes?.length ? { reasonCodes: { hasSome: query.reasonCodes } } : {}),
      ...(query.targetType?.length ? { targetType: { in: query.targetType } } : {}),
      ...(query.riskLevel?.length ? { riskLevel: { in: query.riskLevel } } : {}),
      ...(query.assignedToId ? { assignedToId: query.assignedToId } : {}),
      ...(query.mine ? { assignedToId: actor.id } : {}),
      ...(query.unassigned ? { assignedToId: null } : {}),
      ...(query.overdue ? { dueAt: { lt: now } } : {}),
      ...(query.memberId ? { targetUserId: query.memberId } : {}),
      ...(query.reporterId ? { reports: { some: { reporterId: query.reporterId } } } : {}),
      ...(query.from || query.to
        ? {
            firstReportedAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [total, rows, urgentUnclaimed, overdueCount] = await this.database.$transaction([
      this.database.reportCase.count({ where }),
      this.database.reportCase.findMany({
        where,
        select: ROW_SELECT,
        orderBy: this.orderFor(query, states),
        skip: (query.currentPage - 1) * query.size,
        take: query.size,
      }),
      this.database.reportCase.count({
        where: {
          state: { in: LIVE },
          priority: ReportCasePriority.URGENT,
          assignedToId: null,
        },
      }),
      this.database.reportCase.count({ where: { state: { in: LIVE }, dueAt: { lt: now } } }),
    ]);

    const [targets, categories] = await Promise.all([
      this.resolveTargets(rows),
      this.riskCategories(rows),
    ]);

    return {
      data: rows.map(row =>
        toCaseRow(
          row,
          targets.get(this.key(row)) ?? this.blankTarget(row),
          this.media.sign,
          now,
          categories.get(this.key(row)) ?? null,
        ),
      ),
      meta: buildPageMeta({ currentPage: query.currentPage, perPage: query.size }, total, {
        urgentUnclaimed,
        overdueCount,
      }),
    };
  }

  async detail(actor: AdminPrincipal, id: string) {
    const row = await this.database.reportCase.findUnique({ where: { id }, select: ROW_SELECT });

    if (!row) throw ApiException.notFound('That case could not be found.');

    const [reports, targets, history, liveContent, appeals, scan] = await Promise.all([
      this.database.report.findMany({
        where: { caseId: id },
        select: {
          id: true,
          reasonCode: true,
          note: true,
          state: true,
          createdAt: true,
          outcomeNotifiedAt: true,
          snapshot: true,
          reporter: { select: caseMemberSelect },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.resolveTargets([row]),
      this.history.forTarget(row.targetType, row.targetId, row.id),
      /**
       * The content as it is **now**, which is the whole point of the field: the reports carry a
       * snapshot taken when each one was filed, and a reviewer has to be able to see whether the
       * author has since edited it, had it held, or deleted it themselves.
       *
       * §5.7's page, not a hand-made subset — the same object the content screen and the queue
       * item serve, so the portal draws one component on all three. Null for a case about a
       * member, a conversation or a message: those have no content page, and the thread is
       * `relatedConversationId` instead.
       */
      this.content.page(row.targetType, row.targetId),
      // Real appeals, keyed on this case (§5.11). This was `[]` whatever had happened, so the
      // reviewer of a reopened case could not see that the member had already argued with the
      // first decision — which is exactly the context a reopen needs.
      this.appeals.forCase(id),
      // The scanner's category, for `risk.category`. The case's own is not stored on purpose: the
      // reports disagree about it by nature, and what a reviewer wants to know is what the
      // scanner called the content.
      this.database.contentSafety.findUnique({
        where: {
          targetType_targetId: { targetType: row.targetType, targetId: row.targetId },
        },
        select: { category: true },
      }),
    ]);

    return toCaseDetail(
      row,
      targets.get(this.key(row)) ?? this.blankTarget(row),
      {
        reports,
        targetMemberHistory: row.targetUserId
          ? await this.memberHistory(row.targetUserId, row.id)
          : null,
        relatedConversationId: await this.conversationFor(row),
        history,
        liveContent,
        appeals,
        riskCategory: scan?.category ?? null,
      },
      this.media.sign,
      // R9, and the permission is **`moderation:read`** rather than `reports:read`.
      //
      // Support hold `reports:read` — they need to see that a member has been reported five times
      // in order to answer them — and R9 is explicit that with `reports:read` and no
      // `moderation:read` the response carries `reporter: null` and `reporterNote: null`. Gating
      // on `reports:read` therefore handed Support the identity of everybody who had reported
      // anybody, which is the one fact that turns a report into a reprisal: a support agent
      // talking to an angry member had, on the same screen, the name of the person who reported
      // them.
      actor.permissions.has('moderation:read'),
    );
  }

  /** §7.2: a reviewer takes the case, and nobody else can take it from under them. */
  async claim(actor: AdminPrincipal, id: string) {
    const row = await this.live(id);

    if (row.assignedToId && row.assignedToId !== actor.id) {
      throw ApiException.conflict(
        ApiErrorCode.CLAIMED_BY_OTHER,
        'Someone else is already working on this case.',
        { data: { assignedToId: row.assignedToId } },
      );
    }

    await this.audit.mutate(
      {
        action: 'moderation.claimed',
        targetType: 'REPORT_CASE',
        targetId: id,
        after: { assignedToId: actor.id },
      },
      tx =>
        tx.reportCase.update({
          where: { id },
          data: {
            assignedToId: actor.id,
            claimedAt: new Date(),
            state: ReportCaseState.IN_REVIEW,
            firstActionAt: row.firstActionAt ?? new Date(),
          },
        }),
    );

    return this.row(id);
  }

  /** Hands it back to the pile. Someone else's claim needs `moderation:assign` to break. */
  async release(actor: AdminPrincipal, id: string) {
    const row = await this.live(id);

    if (
      row.assignedToId &&
      row.assignedToId !== actor.id &&
      !actor.permissions.has('moderation:assign')
    ) {
      throw ApiException.forbidden(
        ApiErrorCode.FORBIDDEN,
        'That case is claimed by someone else. A manager can release it.',
      );
    }

    await this.audit.mutate(
      {
        action: 'moderation.released',
        targetType: 'REPORT_CASE',
        targetId: id,
        before: { assignedToId: row.assignedToId },
      },
      tx =>
        tx.reportCase.update({
          where: { id },
          data: { assignedToId: null, claimedAt: null, state: ReportCaseState.OPEN },
        }),
    );

    return this.row(id);
  }

  async assign(actor: AdminPrincipal, id: string, dto: AssignCaseDto) {
    const row = await this.live(id);
    const assigneeId = dto.assigneeId ?? null;

    if (assigneeId !== actor.id && !actor.permissions.has('moderation:assign')) {
      throw ApiException.forbidden(
        ApiErrorCode.FORBIDDEN,
        'Assigning a case to somebody else needs the manager permission.',
      );
    }

    if (assigneeId) await this.assertCanDecide(assigneeId);

    await this.audit.mutate(
      {
        action: 'report.case_assigned',
        targetType: 'REPORT_CASE',
        targetId: id,
        before: { assignedToId: row.assignedToId },
        after: { assignedToId: assigneeId },
        reason: dto.note ?? null,
      },
      tx =>
        tx.reportCase.update({
          where: { id },
          data: {
            assignedToId: assigneeId,
            claimedAt: assigneeId ? new Date() : null,
            state: assigneeId ? ReportCaseState.IN_REVIEW : ReportCaseState.OPEN,
          },
        }),
    );

    return this.row(id);
  }

  /**
   * §7.2's decide, and everything it sets off.
   *
   * The order matters: the content effect and the enforcement first, the case last. A decision
   * recorded before the thing it decided has happened is a case that says a post was removed when
   * it was not — and a reviewer reading the queue would have no way to tell.
   */
  async decide(actor: AdminPrincipal, id: string, dto: CaseDecisionDto) {
    const reason = dto.assertReasoned();
    const row = await this.database.reportCase.findUnique({
      where: { id },
      select: { ...ROW_SELECT, firstActionAt: true, guardThreadId: true },
    });

    if (!row) throw ApiException.notFound('That case could not be found.');

    if (!LIVE.includes(row.state)) {
      // `ALREADY_DECIDED`, not the generic `CONFLICT` (§2.8): the portal branches on the code to
      // decide whether to reload the case or show a validation message, and "conflict" is the one
      // answer that tells it neither.
      throw ApiException.conflict(
        ApiErrorCode.ALREADY_DECIDED,
        'That case has already been decided.',
        { data: { state: row.state, decision: row.decision, decidedAt: row.decidedAt } },
      );
    }

    // Claim before decide, unless the caller is a manager (§7.2: they "can step in on any case").
    if (!actor.permissions.has('moderation:assign')) {
      if (row.assignedToId !== actor.id) {
        throw ApiException.conflict(
          row.assignedToId ? ApiErrorCode.CLAIMED_BY_OTHER : ApiErrorCode.CLAIM_REQUIRED,
          row.assignedToId
            ? 'Someone else is working on this case.'
            : 'Claim the case before deciding it.',
          { data: { assignedToId: row.assignedToId } },
        );
      }
    }

    const dismissing = dto.decision === ModerationDecision.NO_ACTION;
    const escalating = dto.decision === ModerationDecision.ESCALATE_GUARD;
    const removing = REMOVES.includes(dto.decision);
    const now = new Date();

    await this.database.$transaction(async tx => {
      // 1. The content. Removing takes it down and marks the verdict REJECTED; a dismissal
      //    publishes anything the scanner was holding, which is §6.6's APPROVE in everything but
      //    name — the reviewer has looked and said it is fine.
      if (removing) {
        await this.moderation.removeContent(tx, row.targetType, row.targetId);
        await this.safety.applyDecision(tx, {
          targetType: row.targetType,
          targetId: row.targetId,
          state: ContentVisibilityState.REJECTED,
          decision: dto.decision,
          reviewerId: actor.id,
        });
      } else if (dismissing) {
        await this.safety.applyDecision(tx, {
          targetType: row.targetType,
          targetId: row.targetId,
          state: ContentVisibilityState.VISIBLE,
          decision: dto.decision,
          reviewerId: actor.id,
        });
      }

      // 2. Every report in the case gets the same answer, which is the point of grouping them.
      await tx.report.updateMany({
        where: { caseId: id },
        data: {
          state: dismissing ? ReportState.DISMISSED : ReportState.ACTIONED,
          decision: dto.decision,
          decisionNote: reason.note,
          reviewedById: actor.id,
          reviewedAt: now,
        },
      });

      // 3. The queue item the reviewer came in through.
      if (row.queueItemId) {
        await tx.moderationQueueItem.update({
          where: { id: row.queueItemId },
          data: {
            state: ModerationQueueState.RESOLVED,
            decision: dto.decision,
            decisionNote: reason.note,
            decidedById: actor.id,
            decidedAt: now,
          },
        });
      }

      // 4. The case itself.
      await tx.reportCase.update({
        where: { id },
        data: {
          state: escalating
            ? ReportCaseState.ESCALATED
            : dismissing
              ? ReportCaseState.DISMISSED
              : ReportCaseState.ACTIONED,
          decision: dto.decision,
          decisionReasonCode: reason.reasonCode,
          policySubtype: reason.policySubtype,
          decisionNote: reason.note,
          decidedById: actor.id,
          decidedAt: now,
          firstActionAt: row.firstActionAt ?? now,
          assignedToId: row.assignedToId ?? actor.id,
        },
      });

      // 5. The append-only record of what was done to this target, which is what §6.6's history
      //    is built from.
      await tx.moderationAction.create({
        data: {
          actorId: actor.id,
          targetType: row.targetType,
          targetId: row.targetId,
          decision: dto.decision,
          reason: reason.note,
          metadata: { caseId: id, reportCount: row.reportCount },
        },
      });
    });

    // 6. The enforcement, outside the case transaction because each of these is a mutation with
    //    its own audit entry, its own notification and — for a suspension — Redis writes that a
    //    rolled-back transaction could not undo anyway.
    await this.enforce(row.targetUserId, id, dto, reason);

    await this.audit.record(this.database, {
      action: 'report.case_decided',
      targetType: 'REPORT_CASE',
      targetId: id,
      after: { decision: dto.decision, state: escalating ? 'ESCALATED' : undefined },
      reasonCode: reason.reasonCode,
      policySubtype: reason.policySubtype,
      reason: reason.note,
      metadata: { targetType: row.targetType, targetId: row.targetId },
    });

    // 7. Guard, when that is what was decided. After the case transaction, because the thread is
    //    the member module's to open and a failure there must not roll back a decision staff have
    //    already taken — the case reads ESCALATED either way, and an escalation that did not open
    //    is visible as a case with no Guard thread rather than as a decision that vanished.
    if (escalating) await this.openGuardCase(actor, row, dto, reason);

    await this.notifyReporters(id, dto, dismissing);

    return this.detail(actor, id);
  }

  /**
   * `ESCALATE_GUARD`, carried through to a Guard case.
   *
   * Until this existed the decision set the case to `ESCALATED` and stopped. Nothing opened, and
   * §5.10 is explicit that an escalated case is Guard's to close — so the case left ordinary
   * moderation, could not be reopened, and arrived nowhere. A reviewer doing the right thing with
   * a safeguarding concern got a 200 and a dead end.
   */
  private async openGuardCase(
    actor: AdminPrincipal,
    row: { id: string; targetUserId: string | null; targetType: ReportTargetType },
    dto: CaseDecisionDto,
    reason: { reasonCode: AdminReasonCode; policySubtype: string | null; note: string | null },
  ) {
    if (!row.targetUserId) {
      // Nothing to open a case about: a Guard thread is a conversation with a person, and some
      // targets have no single author (a group's own description outlives its creator). Logged
      // rather than thrown — the decision itself was valid and is already recorded.
      this.logger.warn(`Case ${row.id} escalated to Guard with no author to open a thread with.`);

      return;
    }

    try {
      await this.guard.escalate(actor, {
        memberId: row.targetUserId,
        // The member sees this as the thread's subtitle, so it says what the conversation is for
        // and nothing about the report behind it — a subject reading "escalated from report
        // 4f2b" would tell them a report exists and that §7.3 keeps from them.
        subject: GUARD_ESCALATION_SUBJECT,
        categoryCode: dto.guard?.categoryCode ?? null,
        source: GuardCaseSource.REPORT,
        sourceId: row.id,
        reason: { ...reason, note: dto.guard?.note ?? reason.note },
      });
    } catch (error) {
      // The decision stands and is recorded; this is the follow-on. Loudly, because a
      // safeguarding escalation that silently failed to open is the thing this whole path exists
      // to prevent.
      this.logger.error(
        `Case ${row.id} decided ESCALATE_GUARD but the Guard case did not open: ${
          (error as Error).message
        }`,
      );
    }
  }

  /** §5.10: thirty days, and `ESCALATED` cannot come back — Guard owns it now. */
  async reopen(actor: AdminPrincipal, id: string, dto: ReasonOnlyDto) {
    const reason = dto.assertReasoned();
    const row = await this.database.reportCase.findUnique({ where: { id }, select: ROW_SELECT });

    if (!row) throw ApiException.notFound('That case could not be found.');

    const reopenable: ReportCaseState[] = [ReportCaseState.ACTIONED, ReportCaseState.DISMISSED];
    const withinWindow =
      !!row.decidedAt && Date.now() - row.decidedAt.getTime() < REOPEN_WINDOW_DAYS * 86_400_000;

    if (!reopenable.includes(row.state) || !withinWindow) {
      throw ApiException.conflict(
        ApiErrorCode.INVALID_TRANSITION,
        row.state === ReportCaseState.ESCALATED
          ? 'An escalated case is Guard’s to close.'
          : `A case can be reopened for ${REOPEN_WINDOW_DAYS} days after it was decided.`,
        { data: { state: row.state, decidedAt: row.decidedAt?.toISOString() ?? null } },
      );
    }

    await this.audit.mutate(
      {
        action: 'report.case_reopened',
        targetType: 'REPORT_CASE',
        targetId: id,
        before: { state: row.state, decision: row.decision },
        reasonCode: reason.reasonCode,
        policySubtype: reason.policySubtype,
        reason: reason.note,
      },
      tx =>
        tx.reportCase.update({
          where: { id },
          data: {
            // Assigned to whoever reopened it: somebody reopening a case has a reason to look at
            // it, and an unassigned reopened case is one that goes round the queue again.
            state: ReportCaseState.IN_REVIEW,
            assignedToId: actor.id,
            claimedAt: new Date(),
            reopenedAt: new Date(),
            decision: null,
            decidedAt: null,
            decidedById: null,
          },
        }),
    );

    return this.detail(actor, id);
  }

  /** The raw report log (§5.10), for the questions a case list cannot answer. */
  async listReports(actor: AdminPrincipal, query: ListReportsDto) {
    const where: Prisma.ReportWhereInput = {
      ...(query.reasonCodes?.length ? { reasonCode: { in: query.reasonCodes } } : {}),
      ...(query.targetType?.length ? { targetType: { in: query.targetType } } : {}),
      ...(query.state ? { state: query.state as ReportState } : {}),
      ...(query.reporterId ? { reporterId: query.reporterId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [total, rows] = await this.database.$transaction([
      this.database.report.count({ where }),
      this.database.report.findMany({
        where,
        select: {
          id: true,
          caseId: true,
          targetType: true,
          targetId: true,
          reasonCode: true,
          state: true,
          createdAt: true,
          reporter: { select: caseMemberSelect },
        },
        orderBy: { createdAt: 'desc' },
        skip: (query.currentPage - 1) * query.size,
        take: query.size,
      }),
    ]);

    return {
      data: rows.map(row =>
        // R9 again, and the same correction: the log lists individual reports with their
        // reporters, so this is the same disclosure one page further along.
        toReportRow(row, this.media.sign, actor.permissions.has('moderation:read')),
      ),
      meta: buildPageMeta({ currentPage: query.currentPage, perPage: query.size }, total),
    };
  }

  // ─── the parts the methods above lean on ───────────────────────────────────

  private orderFor(
    query: ListReportCasesDto,
    states: ReportCaseState[],
  ): Prisma.ReportCaseOrderByWithRelationInput[] {
    const order = query.order ?? 'desc';

    if (query.sort === 'dueAt') return [{ dueAt: order }];
    if (query.sort === 'reportCount') return [{ reportCount: order }];
    if (query.sort === 'lastReportedAt') return [{ lastReportedAt: order }];
    if (query.sort === 'createdAt') return [{ createdAt: order }];

    // The default depends on what is being listed. Open work sorts by what to do next: urgent
    // first, then whatever is closest to its SLA. A list of decided cases is somebody looking
    // something up, and the most recent decision is the one they mean.
    const live = states.some(state => LIVE.includes(state));

    return live ? [{ priority: 'asc' }, { dueAt: 'asc' }] : [{ createdAt: 'desc' }];
  }

  private async live(id: string) {
    const row = await this.database.reportCase.findUnique({
      where: { id },
      select: { ...ROW_SELECT, firstActionAt: true },
    });

    if (!row) throw ApiException.notFound('That case could not be found.');

    if (!LIVE.includes(row.state)) {
      throw ApiException.conflict(
        ApiErrorCode.INVALID_TRANSITION,
        'That case has been decided. Reopen it first.',
        { data: { state: row.state } },
      );
    }

    return row;
  }

  private async row(id: string) {
    const row = await this.database.reportCase.findUniqueOrThrow({
      where: { id },
      select: ROW_SELECT,
    });
    const targets = await this.resolveTargets([row]);

    return toCaseRow(row, targets.get(this.key(row)) ?? this.blankTarget(row), this.media.sign);
  }

  private async assertCanDecide(assigneeId: string): Promise<void> {
    // "Can act on it", not "can see it" — the same rule the assignee dropdown uses (§5.27). A
    // case handed to somebody who cannot decide it stops looking unassigned to everybody else
    // and sits in a queue they are unable to clear.
    const able = await this.database.user.findFirst({
      where: {
        id: assigneeId,
        isStaff: true,
        deletedAt: null,
        anonymisedAt: null,
        adminCredential: { deactivatedAt: null },
        userRole: {
          role: { rolePermissions: { some: { permission: { code: 'moderation:decide' } } } },
        },
      },
      select: { id: true },
    });

    if (!able) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'That staff member cannot decide cases, so the case would stall with them.',
        { details: [{ field: 'assigneeId', message: 'Needs moderation:decide.' }] },
      );
    }
  }

  /** Warn, suspend and strike go through the member actions, which already do all three. */
  /**
   * What the decision does to the member.
   *
   * Delegated to `AdminEnforcementService`, which the queue's decide path also uses: the same six
   * decisions arrive through both doors and what they mean for the member must not depend on which
   * one. §9's B6 is that exact failure — `WARN_AUTHOR` doing nothing in the queue while the same
   * decision here issued a strike and sent an email.
   */
  private async enforce(
    targetUserId: string | null,
    caseId: string,
    dto: CaseDecisionDto,
    reason: { reasonCode: string; policySubtype: string | null; note: string | null },
  ): Promise<void> {
    await this.enforcement.apply({
      targetUserId,
      decision: dto.decision,
      issueStrike: dto.issueStrike,
      memberMessage: dto.memberMessage,
      suspension: dto.suspension,
      reason,
      sourceType: EnforcementSourceType.REPORT_CASE,
      sourceId: caseId,
      describedBy: `Case ${caseId}`,
    });
  }

  /** §7.3: everyone who reported it is told the outcome, once. */
  private async notifyReporters(
    caseId: string,
    dto: CaseDecisionDto,
    dismissing: boolean,
  ): Promise<void> {
    if (dto.notifyReporters === false) return;

    const pending = await this.database.report.findMany({
      where: { caseId, outcomeNotifiedAt: null },
      select: { id: true, reporterId: true },
    });

    if (!pending.length) return;

    // The wording says nothing about the other member: not what was decided about them, not
    // whether they were warned, not whether they are still here (§7.3).
    const body = dismissing
      ? "We reviewed what you reported and it doesn't break our guidelines."
      : "Thanks — we've taken action on what you reported.";

    for (const report of pending) {
      this.actions.notifyMember(report.reporterId, { title: 'About your report', body });
    }

    await this.database.report.updateMany({
      where: { id: { in: pending.map(report => report.id) } },
      data: { outcomeNotifiedAt: new Date() },
    });
  }

  private key(row: { targetType: ReportTargetType; targetId: string }): string {
    return `${row.targetType}:${row.targetId}`;
  }

  private blankTarget(row: { targetType: ReportTargetType; targetId: string }): CaseTargetView {
    return {
      targetType: row.targetType,
      targetId: row.targetId,
      title: null,
      removed: false,
      conversationId: null,
    };
  }

  /**
   * A line a reviewer can recognise each target by.
   *
   * Built from `CONTENT_SOURCE` rather than a switch of its own: it already knows which table
   * each kind lives in and which of its fields are the ones worth reading, so a new scannable
   * kind shows up here without being added anywhere.
   */
  /**
   * The scanner's category per target, for the row's `risk.category`.
   *
   * One query for the page rather than a join: a case and a safety row are one-to-one on
   * `(target_type, target_id)`, but joining it onto the paged query would mean reaching across a
   * polymorphic key for three columns the list shows and nothing filters on.
   */
  private async riskCategories(rows: Array<{ targetType: ReportTargetType; targetId: string }>) {
    if (!rows.length) return new Map<string, RiskCategory>();

    const scans = await this.database.contentSafety.findMany({
      where: {
        OR: rows.map(row => ({ targetType: row.targetType, targetId: row.targetId })),
        category: { not: null },
      },
      select: { targetType: true, targetId: true, category: true },
    });

    return new Map(scans.map(scan => [`${scan.targetType}:${scan.targetId}`, scan.category]));
  }

  private async resolveTargets(
    rows: Array<{ targetType: ReportTargetType; targetId: string }>,
  ): Promise<Map<string, CaseTargetView>> {
    const byType = new Map<ReportTargetType, string[]>();

    for (const row of rows) {
      byType.set(row.targetType, [...(byType.get(row.targetType) ?? []), row.targetId]);
    }

    const result = new Map<string, CaseTargetView>();

    await Promise.all(
      [...byType.entries()].map(async ([targetType, ids]) => {
        const source = CONTENT_SOURCE[targetType];

        if (!source) return;

        const content = await this.database.$queryRawUnsafe<Array<Record<string, unknown>>>(
          `SELECT * FROM "${source.table}" WHERE "id" = ANY($1::text[])`,
          ids,
        );

        for (const item of content) {
          const fields = source.toFields(item);
          const first = Object.values(fields).find(value => !!value?.trim());

          result.set(`${targetType}:${item.id as string}`, {
            targetType,
            targetId: item.id as string,
            title: first ? first.slice(0, 200) : null,
            removed: (item.deleted_at ?? null) !== null || item.is_active === false,
            conversationId: (item.conversation_id as string | null) ?? null,
          });
        }
      }),
    );

    return result;
  }

  /** The thread §5.6 would open for a case about a message or a conversation. */
  private async conversationFor(row: {
    targetType: ReportTargetType;
    targetId: string;
  }): Promise<string | null> {
    if (row.targetType === ReportTargetType.CONVERSATION) return row.targetId;

    if (row.targetType !== ReportTargetType.MESSAGE) return null;

    const message = await this.database.message.findUnique({
      where: { id: row.targetId },
      select: { conversationId: true },
    });

    return message?.conversationId ?? null;
  }

  /** What else is known about the reported member, which is what a decision is weighed against. */
  private async memberHistory(userId: string, caseId: string) {
    const now = new Date();
    const [activeStrikes, priorCases, priorActioned, suspensions, member] = await Promise.all([
      this.database.strike.count({
        where: { userId, revokedAt: null, expiresAt: { gt: now } },
      }),
      this.database.reportCase.count({ where: { targetUserId: userId, NOT: { id: caseId } } }),
      this.database.reportCase.count({
        where: { targetUserId: userId, state: ReportCaseState.ACTIONED, NOT: { id: caseId } },
      }),
      this.database.suspension.count({ where: { userId } }),
      this.database.user.findUnique({ where: { id: userId }, select: { createdAt: true } }),
    ]);

    return {
      activeStrikes,
      priorCases,
      priorActioned,
      accountAgeDays: member
        ? Math.floor((now.getTime() - member.createdAt.getTime()) / 86_400_000)
        : 0,
      suspensions,
    };
  }
}
