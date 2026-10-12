import { Injectable, Logger } from '@nestjs/common';
import {
  AdminReasonCode,
  AppealState,
  AppealSubjectType,
  ContentVisibilityState,
  ModerationDecision,
  ModerationQueueState,
  ModerationQueueType,
  Prisma,
  ReportCaseState,
  ReportTargetType,
  RiskLevel,
} from '@prisma/client';
import { ApiErrorCode, ApiException, SYSTEM_CONFIG_KEYS, buildPageMeta, toJson } from '@/common';
import { PrismaService } from '@/infrastructure';
import { ContentSafetyService, MediaService, SystemConfigService } from '@/modules/platform/shared';
import { AuditService } from '../audit/audit.service';
import { AdminPrincipal } from '../common/admin-principal';
import { CreateAppealDto, DecideAppealDto, ListAppealsDto } from '../dtos/admin-appeal.dto';
import { ReasonOnlyDto } from '../dtos/admin-member-actions.dto';
import { caseMemberSelect } from '../serializers/admin-report-case.serializer';
import { staffRefSelect, toStaffRef } from '../serializers/admin-staff.serializer';
import { toMemberRef } from '../serializers/admin-member.serializer';
import { AdminMemberActionService } from './admin-member-action.service';
import { AdminModerationService } from './admin-moderation.service';

/** The states an appeal is still work in. */
const LIVE: AppealState[] = [AppealState.OPEN, AppealState.IN_REVIEW];

/**
 * §5.11: a member arguing with a decision.
 *
 * Two things make this different from every other queue. The appeal is **logged by staff** — it
 * arrives through Support in the member's own words and somebody writes it down — so a row has two
 * people on it, the member whose words they are and the staff member who took them. And R6: the
 * person who made the original decision cannot be the one who reviews the appeal, which is checked
 * when the case is claimed rather than only when it is decided, because by then the reviewer has
 * already read it.
 */
@Injectable()
export class AdminAppealService {
  private readonly logger = new Logger(AdminAppealService.name);

  constructor(
    private readonly database: PrismaService,
    private readonly media: MediaService,
    private readonly config: SystemConfigService,
    private readonly safety: ContentSafetyService,
    private readonly moderation: AdminModerationService,
    private readonly actions: AdminMemberActionService,
    private readonly audit: AuditService,
  ) {}

  /** Logs what a member said, and opens the work item for it. */
  async log(actor: AdminPrincipal, dto: CreateAppealDto) {
    const subject = await this.resolveSubject(dto);
    const hours = await this.config.get(SYSTEM_CONFIG_KEYS.APPEALS_SLA_HOURS);

    const open = await this.database.appeal.findFirst({
      where: {
        subjectType: dto.subjectType,
        subjectId: dto.subjectId,
        state: { in: LIVE },
      },
      select: { id: true },
    });

    if (open) {
      throw ApiException.conflict(
        ApiErrorCode.CONFLICT,
        'There is already an open appeal about that decision.',
        { data: { appealId: open.id } },
      );
    }

    const { result } = await this.audit.mutate(
      (created: { id: string }) => ({
        action: 'appeal.logged',
        targetType: 'MEMBER' as const,
        targetId: dto.memberId,
        after: {
          appealId: created.id,
          subjectType: dto.subjectType,
          subjectId: dto.subjectId,
        },
        reason: dto.note ?? null,
      }),
      async tx => {
        // One deadline for both rows. The appeal carries the SLA; the queue item is the way in to
        // it, and an item with a different deadline to the thing it points at is a queue that
        // disagrees with its own detail page.
        const dueAt = new Date(Date.now() + hours * 3_600_000);

        const appeal = await tx.appeal.create({
          data: {
            userId: dto.memberId,
            subjectType: dto.subjectType,
            subjectId: dto.subjectId,
            originalDeciderId: subject.deciderId,
            supportConversationId: dto.supportConversationId ?? null,
            statement: dto.statement,
            loggedById: actor.id,
            dueAt,
          },
          select: { id: true },
        });

        // The reviewer's way in, keyed on what the appeal is *about* rather than on the member.
        //
        // The queue's unique key is `(type, targetType, targetId)` with nothing about the appeal
        // in it, so keying these on the member would give each member one appeal item for ever —
        // the second one is a unique violation, which is a 500 on a member's appeal. Pointing it
        // at the content the decision was about gives one item per decision, which is what a
        // reviewer wants anyway. Appeals with no content behind them (a strike, a suspension)
        // fall back to the member, and `upsert` is what makes a second one of those reuse the row
        // instead of failing.
        const item = subject.target ?? {
          targetType: ReportTargetType.USER,
          targetId: dto.memberId,
        };

        await tx.moderationQueueItem.upsert({
          where: {
            type_targetType_targetId: { type: ModerationQueueType.APPEAL, ...item },
          },
          update: {
            state: ModerationQueueState.PENDING,
            assignedToId: null,
            decision: null,
            decisionNote: null,
            decidedById: null,
            decidedAt: null,
            subjectUserId: dto.memberId,
            summary: `Appeal: ${dto.subjectType.toLowerCase().replace('_', ' ')}`,
            payload: toJson({ appealId: appeal.id, caseId: subject.caseId }),
            // A second appeal on the same decision is new work with a new clock.
            dueAt,
          },
          create: {
            type: ModerationQueueType.APPEAL,
            ...item,
            subjectUserId: dto.memberId,
            riskLevel: RiskLevel.LOW,
            riskScore: 0,
            dueAt,
            summary: `Appeal: ${dto.subjectType.toLowerCase().replace('_', ' ')}`,
            payload: toJson({ appealId: appeal.id, caseId: subject.caseId }),
          },
        });

        return appeal;
      },
    );

    return this.view(result.id);
  }

  async list(actor: AdminPrincipal, query: ListAppealsDto) {
    const now = new Date();
    const states = query.state?.length ? query.state : LIVE;
    const where: Prisma.AppealWhereInput = {
      state: { in: states },
      ...(query.memberId ? { userId: query.memberId } : {}),
      ...(query.mine ? { reviewerId: actor.id } : {}),
      ...(query.overdue ? { dueAt: { lt: now } } : {}),
    };

    const [total, rows] = await this.database.$transaction([
      this.database.appeal.count({ where }),
      this.database.appeal.findMany({
        where,
        include: {
          user: { select: caseMemberSelect },
        },
        orderBy: [{ dueAt: 'asc' }],
        skip: (query.currentPage - 1) * query.size,
        take: query.size,
      }),
    ]);

    const staff = await this.staffFor(rows);

    return {
      data: rows.map(row => this.toView(row, staff, now)),
      meta: buildPageMeta({ currentPage: query.currentPage, perPage: query.size }, total, {
        overdueCount: await this.database.appeal.count({
          where: { state: { in: LIVE }, dueAt: { lt: now } },
        }),
      }),
    };
  }

  /** The review page's own fetch: never the list, filtered client-side. */
  async detail(id: string) {
    const view = await this.view(id);
    const subject = await this.describeSubject(view.subjectType, view.subjectId);

    return { ...view, subject };
  }

  /** §5.11: R6 is checked here, not only at decide — by then the reviewer has read it. */
  async claim(actor: AdminPrincipal, id: string) {
    const appeal = await this.live(id);

    this.assertNotTheDecider(actor, appeal.originalDeciderId);

    if (appeal.reviewerId && appeal.reviewerId !== actor.id) {
      throw ApiException.conflict(
        ApiErrorCode.CLAIMED_BY_OTHER,
        'Someone else is already reviewing this appeal.',
        { data: { reviewerId: appeal.reviewerId } },
      );
    }

    await this.database.$transaction(async tx => {
      await tx.appeal.update({
        where: { id },
        data: { reviewerId: actor.id, state: AppealState.IN_REVIEW },
      });

      // One claim, kept in sync (§5.9): the queue item and the appeal are two views of one job.
      await tx.moderationQueueItem.updateMany({
        where: { type: ModerationQueueType.APPEAL, payload: { path: ['appealId'], equals: id } },
        data: { assignedToId: actor.id, state: ModerationQueueState.IN_REVIEW },
      });
    });

    return this.view(id);
  }

  /**
   * §5.11's decide, and what `OVERTURNED` undoes.
   *
   * Upholding is a sentence in the trail and a message to the member. Overturning has to reach
   * everything the original decision touched — the strike, the content, the suspension — and each
   * of those is a different kind of undo, which is why they are dispatched on the subject type
   * rather than attempted generically.
   */
  async decide(actor: AdminPrincipal, id: string, dto: DecideAppealDto) {
    const reason = dto.assertReasoned();
    const appeal = await this.live(id);

    this.assertNotTheDecider(actor, appeal.originalDeciderId);

    if (!actor.permissions.has('moderation:assign') && appeal.reviewerId !== actor.id) {
      throw ApiException.conflict(
        appeal.reviewerId ? ApiErrorCode.CLAIMED_BY_OTHER : ApiErrorCode.CLAIM_REQUIRED,
        appeal.reviewerId
          ? 'Someone else is reviewing this appeal.'
          : 'Claim the appeal before deciding it.',
        { data: { reviewerId: appeal.reviewerId } },
      );
    }

    const overturning = dto.outcome === AppealState.OVERTURNED;

    await this.database.$transaction(async tx => {
      await tx.appeal.update({
        where: { id },
        data: {
          state: dto.outcome,
          decisionNote: dto.decisionNote,
          decidedAt: new Date(),
          reviewerId: appeal.reviewerId ?? actor.id,
        },
      });

      await tx.moderationQueueItem.updateMany({
        where: { type: ModerationQueueType.APPEAL, payload: { path: ['appealId'], equals: id } },
        data: {
          state: ModerationQueueState.RESOLVED,
          decision: overturning ? ModerationDecision.APPROVE : ModerationDecision.NO_ACTION,
          decisionNote: dto.decisionNote,
          decidedById: actor.id,
          decidedAt: new Date(),
        },
      });
    });

    if (overturning) await this.undo(actor, appeal);

    await this.audit.record(this.database, {
      action: 'appeal.decided',
      targetType: 'MEMBER',
      targetId: appeal.userId,
      after: { appealId: id, outcome: dto.outcome },
      reasonCode: reason.reasonCode,
      policySubtype: reason.policySubtype,
      reason: dto.decisionNote,
      metadata: { subjectType: appeal.subjectType, subjectId: appeal.subjectId },
    });

    this.actions.notifyMember(appeal.userId, {
      title: overturning ? 'We’ve changed our decision' : 'We’ve reviewed our decision',
      body:
        dto.memberMessage ??
        (overturning
          ? 'We looked at this again and have reversed it. Thanks for telling us.'
          : 'We looked at this again and the original decision stands.'),
    });

    return this.view(id);
  }

  // ─── what overturning actually undoes ──────────────────────────────────────

  private async undo(
    actor: AdminPrincipal,
    appeal: { id: string; userId: string; subjectType: AppealSubjectType; subjectId: string },
  ): Promise<void> {
    try {
      switch (appeal.subjectType) {
        case AppealSubjectType.REPORT_CASE:
          await this.undoCase(actor, appeal.subjectId, appeal.userId);
          break;
        case AppealSubjectType.STRIKE:
          await this.revoke(appeal.userId, appeal.subjectId);
          break;
        case AppealSubjectType.SUSPENSION:
          await this.lift(appeal.userId);
          break;
        case AppealSubjectType.CONTENT_DECISION:
        case AppealSubjectType.ANONYMOUS_REJECTION:
          await this.restoreVerdict(appeal.subjectId, actor.id);
          break;
      }
    } catch (error) {
      // The appeal is decided and the member has been told. An undo that fails after that is
      // loud rather than silent: a reviewer who overturned a decision needs to know the content
      // did not come back, and the member is owed what they were promised.
      this.logger.error(
        `Appeal ${appeal.id} overturned but the undo failed (${appeal.subjectType} ${appeal.subjectId}): ${
          (error as Error).message
        }`,
      );
    }
  }

  /** A case decision reversed: the content comes back, and so does whatever it cost the member. */
  private async undoCase(actor: AdminPrincipal, caseId: string, userId: string): Promise<void> {
    const row = await this.database.reportCase.findUnique({
      where: { id: caseId },
      select: { targetType: true, targetId: true, decision: true },
    });

    if (!row) return;

    const removals: ModerationDecision[] = [
      ModerationDecision.REMOVE_CONTENT,
      ModerationDecision.REMOVE_AND_WARN,
      ModerationDecision.REMOVE_AND_SUSPEND,
    ];
    const removed = removals.includes(row.decision ?? ModerationDecision.NO_ACTION);

    await this.database.$transaction(async tx => {
      if (removed) {
        await this.moderation.restoreContent(tx, row.targetType, row.targetId);
        await this.safety.applyDecision(tx, {
          targetType: row.targetType,
          targetId: row.targetId,
          state: ContentVisibilityState.VISIBLE,
          decision: ModerationDecision.APPROVE,
          reviewerId: actor.id,
        });
      }

      // The case itself says it was overturned. Not deleted and not reopened: the decision was
      // made, and the trail has to show that it was made and then reversed.
      await tx.reportCase.update({
        where: { id: caseId },
        data: { state: ReportCaseState.DISMISSED, decision: ModerationDecision.NO_ACTION },
      });
    });

    // Everything the decision cost the member, found by where it came from rather than by
    // guessing: the enforcement rows carry the case id.
    const strikes = await this.database.strike.findMany({
      where: { userId, sourceType: 'REPORT_CASE', sourceId: caseId, revokedAt: null },
      select: { id: true },
    });

    for (const strike of strikes) await this.revoke(userId, strike.id);

    const suspension = await this.database.suspension.findFirst({
      where: { userId, sourceType: 'REPORT_CASE', sourceId: caseId, liftedAt: null },
      select: { id: true },
    });

    if (suspension) await this.lift(userId);
  }

  private async revoke(userId: string, strikeId: string): Promise<void> {
    await this.actions.revokeStrike(userId, strikeId, this.reasoned());
  }

  private async lift(userId: string): Promise<void> {
    await this.actions.reactivate(userId, this.reasoned());
  }

  /** Content held or rejected by a decision, published again. */
  private async restoreVerdict(contentSafetyId: string, reviewerId: string): Promise<void> {
    const verdict = await this.database.contentSafety.findUnique({
      where: { id: contentSafetyId },
      select: { targetType: true, targetId: true },
    });

    if (!verdict) return;

    await this.database.$transaction(async tx => {
      await this.moderation.restoreContent(tx, verdict.targetType, verdict.targetId);
      await this.safety.applyDecision(tx, {
        targetType: verdict.targetType,
        targetId: verdict.targetId,
        state: ContentVisibilityState.VISIBLE,
        decision: ModerationDecision.APPROVE,
        reviewerId,
      });
    });
  }

  /**
   * The reason an undo is recorded with.
   *
   * `MEMBER_REQUEST` because that is what it was: the member asked, and a human agreed. The
   * appeal's own `decisionNote` is where the reasoning lives, and the audit entry for the appeal
   * carries it — this is the reason on the *enforcement* rows, which is a different sentence.
   */
  private reasoned(): ReasonOnlyDto {
    // A real DTO instance, so `assertReasoned` is the one in `ReasonedDto` and these calls go
    // through exactly what the member screens go through rather than through a lookalike.
    return Object.assign(new ReasonOnlyDto(), {
      reasonCode: AdminReasonCode.MEMBER_REQUEST,
      note: 'Appeal upheld: the original decision was overturned.',
    });
  }

  // ─── reads ─────────────────────────────────────────────────────────────────

  private async live(id: string) {
    const appeal = await this.database.appeal.findUnique({ where: { id } });

    if (!appeal) throw ApiException.notFound('That appeal could not be found.');

    if (!LIVE.includes(appeal.state)) {
      throw ApiException.conflict(
        ApiErrorCode.INVALID_TRANSITION,
        'That appeal has already been decided.',
        { data: { state: appeal.state, decidedAt: appeal.decidedAt?.toISOString() ?? null } },
      );
    }

    return appeal;
  }

  /** R6, in one place: the decider cannot review their own decision. */
  private assertNotTheDecider(actor: AdminPrincipal, originalDeciderId: string | null): void {
    if (originalDeciderId && originalDeciderId === actor.id) {
      throw ApiException.forbidden(
        ApiErrorCode.APPEAL_REVIEWER_CONFLICT,
        'You made the decision being appealed. Somebody else has to review this one.',
      );
    }
  }

  private async view(id: string) {
    const row = await this.database.appeal.findUniqueOrThrow({
      where: { id },
      include: { user: { select: caseMemberSelect } },
    });
    const staff = await this.staffFor([row]);

    return this.toView(row, staff);
  }

  private async staffFor(
    rows: Array<{
      loggedById: string;
      reviewerId: string | null;
      originalDeciderId: string | null;
    }>,
  ) {
    const ids = [
      ...new Set(rows.flatMap(row => [row.loggedById, row.reviewerId, row.originalDeciderId])),
    ].filter((id): id is string => !!id);

    if (!ids.length) return new Map<string, Awaited<ReturnType<typeof this.staffRows>>[number]>();

    const staff = await this.staffRows(ids);

    return new Map(staff.map(person => [person.id, person]));
  }

  private staffRows(ids: string[]) {
    return this.database.user.findMany({ where: { id: { in: ids } }, select: staffRefSelect });
  }

  private toView(
    row: {
      id: string;
      userId: string;
      user: Parameters<typeof toMemberRef>[0];
      subjectType: AppealSubjectType;
      subjectId: string;
      statement: string;
      state: AppealState;
      loggedById: string;
      reviewerId: string | null;
      originalDeciderId: string | null;
      supportConversationId: string | null;
      dueAt: Date;
      decidedAt: Date | null;
      decisionNote: string | null;
      createdAt: Date;
    },
    staff: Map<string, Parameters<typeof toStaffRef>[0]>,
    now = new Date(),
  ) {
    const ref = (id: string | null) => {
      const person = id ? staff.get(id) : null;

      return person ? toStaffRef(person, this.media.sign) : null;
    };

    return {
      id: row.id,
      member: toMemberRef(row.user, this.media.sign),
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      statement: row.statement,
      state: row.state,
      loggedBy: ref(row.loggedById),
      reviewer: ref(row.reviewerId),
      originalDecider: ref(row.originalDeciderId),
      dueAt: row.dueAt.toISOString(),
      overdue: LIVE.includes(row.state) && row.dueAt.getTime() < now.getTime(),
      decidedAt: row.decidedAt?.toISOString() ?? null,
      decisionNote: row.decisionNote,
      supportConversationId: row.supportConversationId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * What is being appealed has to exist, be about this member, and be something there is still a
   * decision to argue with (§5.11).
   *
   * Returns who decided it, which is R6's whole input.
   */
  private async resolveSubject(dto: CreateAppealDto): Promise<{
    deciderId: string | null;
    caseId: string | null;
    /** The content the decision was about, where there is some. */
    target: { targetType: ReportTargetType; targetId: string } | null;
  }> {
    const invalid = (message: string) =>
      ApiException.badRequest(ApiErrorCode.VALIDATION_FAILED, message, {
        details: [{ field: 'subjectId', message }],
      });

    if (dto.subjectType === AppealSubjectType.REPORT_CASE) {
      const row = await this.database.reportCase.findUnique({
        where: { id: dto.subjectId },
        select: {
          targetUserId: true,
          state: true,
          decidedById: true,
          targetType: true,
          targetId: true,
        },
      });

      if (!row) throw invalid('That case could not be found.');

      if (row.targetUserId !== dto.memberId) {
        throw invalid('That case is not about this member.');
      }

      const decided: ReportCaseState[] = [ReportCaseState.ACTIONED, ReportCaseState.ESCALATED];

      if (!decided.includes(row.state)) {
        throw invalid('There is nothing to appeal until the case has been decided.');
      }

      return {
        deciderId: row.decidedById,
        caseId: dto.subjectId,
        target: { targetType: row.targetType, targetId: row.targetId },
      };
    }

    if (dto.subjectType === AppealSubjectType.STRIKE) {
      const strike = await this.database.strike.findFirst({
        where: { id: dto.subjectId, userId: dto.memberId },
        select: { issuedById: true, revokedAt: true },
      });

      if (!strike) throw invalid('That strike could not be found for this member.');
      if (strike.revokedAt) throw invalid('That strike has already been withdrawn.');

      return { deciderId: strike.issuedById, caseId: null, target: null };
    }

    if (dto.subjectType === AppealSubjectType.SUSPENSION) {
      const suspension = await this.database.suspension.findFirst({
        where: { id: dto.subjectId, userId: dto.memberId },
        select: { issuedById: true, liftedAt: true },
      });

      if (!suspension) throw invalid('That suspension could not be found for this member.');
      if (suspension.liftedAt) throw invalid('That suspension has already been lifted.');

      return { deciderId: suspension.issuedById, caseId: null, target: null };
    }

    const verdict = await this.database.contentSafety.findUnique({
      where: { id: dto.subjectId },
      select: {
        authorId: true,
        reviewedById: true,
        visibilityState: true,
        targetType: true,
        targetId: true,
      },
    });

    if (!verdict) throw invalid('That content decision could not be found.');

    if (verdict.authorId !== dto.memberId) {
      throw invalid('That content was not written by this member.');
    }

    if (verdict.visibilityState === ContentVisibilityState.VISIBLE) {
      throw invalid('That content is published, so there is nothing to appeal.');
    }

    return {
      deciderId: verdict.reviewedById,
      caseId: null,
      target: { targetType: verdict.targetType, targetId: verdict.targetId },
    };
  }

  /** A line describing what is being appealed, for the review page. */
  private async describeSubject(
    subjectType: AppealSubjectType,
    subjectId: string,
  ): Promise<{ kind: AppealSubjectType; id: string; summary: string | null } | null> {
    if (subjectType === AppealSubjectType.REPORT_CASE) {
      const row = await this.database.reportCase.findUnique({
        where: { id: subjectId },
        select: { decision: true, decisionNote: true, targetType: true },
      });

      return row
        ? {
            kind: subjectType,
            id: subjectId,
            summary: `${row.targetType}: ${row.decision ?? 'no decision'}${
              row.decisionNote ? ` — ${row.decisionNote}` : ''
            }`,
          }
        : null;
    }

    if (subjectType === AppealSubjectType.STRIKE) {
      const strike = await this.database.strike.findUnique({
        where: { id: subjectId },
        select: { note: true, reasonCode: true, revokedAt: true },
      });

      return strike
        ? {
            kind: subjectType,
            id: subjectId,
            summary: `${strike.reasonCode}${strike.note ? ` — ${strike.note}` : ''}${
              strike.revokedAt ? ' (withdrawn)' : ''
            }`,
          }
        : null;
    }

    if (subjectType === AppealSubjectType.SUSPENSION) {
      const suspension = await this.database.suspension.findUnique({
        where: { id: subjectId },
        select: { endsAt: true, note: true, liftedAt: true },
      });

      return suspension
        ? {
            kind: subjectType,
            id: subjectId,
            summary: `${suspension.endsAt ? `until ${suspension.endsAt.toISOString()}` : 'indefinite'}${
              suspension.note ? ` — ${suspension.note}` : ''
            }${suspension.liftedAt ? ' (lifted)' : ''}`,
          }
        : null;
    }

    const verdict = await this.database.contentSafety.findUnique({
      where: { id: subjectId },
      select: { targetType: true, targetId: true, visibilityState: true, tier: true },
    });

    return verdict
      ? {
          kind: subjectType,
          id: subjectId,
          summary: `${verdict.targetType} ${verdict.targetId}: ${verdict.visibilityState} (${verdict.tier})`,
        }
      : null;
  }
}
