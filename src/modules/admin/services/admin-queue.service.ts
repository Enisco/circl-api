import { Injectable, Logger } from '@nestjs/common';
import {
  AppealState,
  ContentRiskTier,
  ContentVisibilityState,
  EnforcementSourceType,
  GuardCaseSource,
  ModerationDecision,
  ModerationQueueState,
  ModerationQueueType,
  Prisma,
  ReportCasePriority,
  RiskLevel,
  RiskTermHitOutcome,
} from '@prisma/client';
import { ApiErrorCode, ApiException, buildPageMeta } from '@/common';
import { PrismaService } from '@/infrastructure';
import { ContentSafetyService, MediaService, allowedDecisionsFor } from '@/modules/platform/shared';
import { AutoGuideService } from '@/modules/platform/intelligence';
import { AuditService } from '../audit/audit.service';
import { AdminAssigneeService } from './admin-assignee.service';
import { AdminGuardService, GUARD_ESCALATION_SUBJECT } from './admin-guard.service';
import { AdminPrincipal } from '../common/admin-principal';
import {
  DecideQueueDto,
  DEFAULT_QUEUE_TYPES,
  ListQueueItemsDto,
  OPEN_QUEUE_STATES,
} from '../dtos/admin-queue.dto';
import { caseMemberSelect } from '../serializers/admin-report-case.serializer';
import { toMemberRef } from '../serializers/admin-member.serializer';
import { staffRefSelect, toStaffRef } from '../serializers/admin-staff.serializer';
import { AdminContentTargetService, ContentTargetView } from './admin-content-target.service';
import { AdminEnforcementService, REMOVES, SUSPENDS } from './admin-enforcement.service';
import { AdminMemberActionService } from './admin-member-action.service';
import { AdminModerationService } from './admin-moderation.service';

/** The row shape every queue read returns, so a list row and a detail agree about the basics. */
const ROW_SELECT = {
  id: true,
  type: true,
  state: true,
  priority: true,
  dueAt: true,
  targetType: true,
  targetId: true,
  reportId: true,
  riskLevel: true,
  riskCategory: true,
  riskScore: true,
  riskSignals: true,
  summary: true,
  payload: true,
  decision: true,
  decisionNote: true,
  decidedById: true,
  decidedAt: true,
  createdAt: true,
  updatedAt: true,
  assignedToId: true,
  subjectUserId: true,
  subjectUser: { select: caseMemberSelect },
  assignedTo: { select: staffRefSelect },
} satisfies Prisma.ModerationQueueItemSelect;

type QueueRow = Prisma.ModerationQueueItemGetPayload<{ select: typeof ROW_SELECT }>;

/**
 * §5.9's queue, as a reviewer works it.
 *
 * Split out of `AdminModerationService`, which still owns the removal switch and the action trail.
 * The reason for the split is that the two do different jobs: that service is about *effects* on
 * content, and this one is about the list of work and who holds what. Keeping the read side here
 * also keeps the old `listQueue` available while the portal moves over.
 *
 * What was wrong with the old one, and why each is worth naming:
 *
 * - **One `type` and one `state`.** A reviewer working tabs asks for several of each.
 * - **`reportCount` was `row.reportId ? 1 : 0`** — so a post twelve people reported said "1". The
 *   number is now counted off `Report`, which is where it has always lived.
 * - **No deadline and no priority**, so there was no answer to "what is about to breach" — the
 *   only question a queue is really for.
 * - **No `allowedDecisions`**, so the portal inferred the buttons and could offer `APPROVE` on
 *   content nobody had held.
 * - **Content on only six of twenty target types**, so a flagged guide or shop arrived as a row
 *   with nothing on it.
 */
@Injectable()
export class AdminQueueService {
  private readonly logger = new Logger(AdminQueueService.name);

  constructor(
    private readonly database: PrismaService,
    private readonly media: MediaService,
    private readonly targets: AdminContentTargetService,
    private readonly audit: AuditService,
    private readonly safety: ContentSafetyService,
    private readonly moderation: AdminModerationService,
    private readonly enforcement: AdminEnforcementService,
    private readonly actions: AdminMemberActionService,
    private readonly guides: AutoGuideService,
    private readonly assignees: AdminAssigneeService,
    private readonly guard: AdminGuardService,
  ) {}

  // ─── Read ──────────────────────────────────────────────────────────────────

  async list(actor: AdminPrincipal, query: ListQueueItemsDto) {
    const now = new Date();
    const types = query.type?.length ? query.type : DEFAULT_QUEUE_TYPES;
    const states = query.state?.length ? query.state : OPEN_QUEUE_STATES;
    const where: Prisma.ModerationQueueItemWhereInput = {
      type: { in: types },
      state: { in: states },
      ...(query.priority?.length ? { priority: { in: query.priority } } : {}),
      ...(query.targetType?.length ? { targetType: { in: query.targetType } } : {}),
      ...(query.minRiskLevel ? { riskLevel: { in: atOrAbove(query.minRiskLevel) } } : {}),
      ...(query.mine ? { assignedToId: actor.id } : {}),
      ...(query.assignedToId ? { assignedToId: query.assignedToId } : {}),
      ...(query.unassigned ? { assignedToId: null } : {}),
      ...(query.overdue ? { dueAt: { lt: now } } : {}),
    };

    const [total, rows] = await this.database.$transaction([
      this.database.moderationQueueItem.count({ where }),
      this.database.moderationQueueItem.findMany({
        where,
        select: ROW_SELECT,
        orderBy: this.orderFor(query.sort, query.order),
        skip: (query.currentPage - 1) * query.size,
        take: query.size,
      }),
    ]);

    const [targets, reportCounts] = await Promise.all([
      this.targets.resolve(rows),
      this.reportCounts(rows),
    ]);

    // Tier filtering happens here rather than in the `where`: the tier lives on `ContentSafety`,
    // which is a polymorphic table with no relation to join on. Filtering a page after the fact
    // would make the paging lie, so the count is taken from the filtered set and the caller is
    // told. It is the one filter that cannot be pushed down, and saying so is better than a
    // `meta.total` that disagrees with the rows beneath it.
    const tiers = await this.tiersFor(rows);
    const visible = query.tier?.length
      ? rows.filter(row => {
          const tier = tiers.get(this.targets.key(row));

          return tier ? query.tier!.includes(tier) : false;
        })
      : rows;

    return {
      data: visible.map(row =>
        this.toRow(row, targets.get(this.targets.key(row)) ?? null, reportCounts, now),
      ),
      meta: buildPageMeta(
        { currentPage: query.currentPage, perPage: query.size },
        query.tier?.length ? visible.length : total,
        {
          urgentCount: await this.database.moderationQueueItem.count({
            where: { state: { in: OPEN_QUEUE_STATES }, priority: ReportCasePriority.URGENT },
          }),
          overdueCount: await this.database.moderationQueueItem.count({
            where: { state: { in: OPEN_QUEUE_STATES }, dueAt: { lt: now } },
          }),
          // Always the open counts, whatever the caller filtered by — otherwise the tab badges
          // would change as somebody moves between tabs, which is not what a badge is for.
          countsByType: await this.countsByType(),
          ...(query.tier?.length ? { tierFilterIsPageLocal: true } : {}),
        },
      ),
    };
  }

  /** One item, with everything a decision needs and nothing a list needs to carry. */
  async detail(id: string) {
    const row = await this.database.moderationQueueItem.findUnique({
      where: { id },
      select: ROW_SELECT,
    });

    if (!row) throw ApiException.notFound('That queue item could not be found.');

    const now = new Date();
    const [targets, reportCounts, history] = await Promise.all([
      this.targets.resolve([row]),
      this.reportCounts([row]),
      this.historyFor(row),
    ]);
    const target = targets.get(this.targets.key(row)) ?? null;

    return {
      ...this.toRow(row, target, reportCounts, now),
      /**
       * The scanned fields, by name. §5.9 is explicit that `risk.signals[].start/end` are UTF-16
       * offsets into **these** strings — so they have to be the text the scanner read, not a
       * rendered or truncated version of it, or the portal highlights the wrong words.
       */
      contentDetail: target
        ? {
            targetType: target.targetType,
            targetId: target.targetId,
            body: target.fields,
            removed: target.removed,
            visibilityState: target.visibilityState,
            conversationId: target.conversationId,
          }
        : null,
      authorHistory: row.subjectUserId ? await this.authorHistory(row.subjectUserId) : null,
      payload: row.payload ?? null,
      history,
    };
  }

  /**
   * The tab headers: how much is waiting, how much is being worked, how much is late, and how old
   * the oldest is.
   *
   * `oldestAt` rather than an age in days, because an age computed server-side is stale by the
   * time it is rendered and the portal already formats dates.
   */
  async summary() {
    const now = new Date();
    const grouped = await this.database.moderationQueueItem.groupBy({
      by: ['type', 'state'],
      _count: { id: true },
      _min: { createdAt: true },
    });
    const overdue = await this.database.moderationQueueItem.groupBy({
      by: ['type'],
      _count: { id: true },
      where: { state: { in: OPEN_QUEUE_STATES }, dueAt: { lt: now } },
    });
    const overdueByType = new Map(overdue.map(row => [row.type, row._count.id]));

    const byType: Record<
      string,
      { pending: number; inReview: number; overdue: number; oldestAt: string | null }
    > = {};

    for (const type of Object.values(ModerationQueueType)) {
      byType[type] = {
        pending: 0,
        inReview: 0,
        overdue: overdueByType.get(type) ?? 0,
        oldestAt: null,
      };
    }

    for (const row of grouped) {
      const entry = byType[row.type];

      if (row.state === ModerationQueueState.PENDING) entry.pending = row._count.id;
      if (row.state === ModerationQueueState.IN_REVIEW) entry.inReview = row._count.id;

      // The oldest **open** item, so a resolved backlog does not make the tab look ancient.
      if (row.state !== ModerationQueueState.RESOLVED && row._min.createdAt) {
        const candidate = row._min.createdAt.toISOString();

        entry.oldestAt = !entry.oldestAt || candidate < entry.oldestAt ? candidate : entry.oldestAt;
      }
    }

    return { byType };
  }

  // ─── Decide ────────────────────────────────────────────────────────────────

  /**
   * §5.9's decision, and §9's B6.
   *
   * Three of these did nothing at all before. `WARN_AUTHOR` issued no strike and sent no
   * notification — a reviewer pressed "warn the author" and the author was never warned.
   * `APPROVE` left held content held, so an approved anonymous post stayed invisible and an
   * approved auto-guide was never published (`AutoGuideService.publish` had no caller). `REJECT`
   * did nothing for an anonymous post. The item closed and the trail said a decision had been
   * taken, which is worse than an error: the queue emptied and nothing happened.
   *
   * **Everything is validated before anything moves.** A decision rejected half way would leave
   * the content down and the strike unissued, or the strike issued and the item open — and §5.9 is
   * explicit that a refused decision leaves no strike behind.
   */
  async decide(actor: AdminPrincipal, id: string, dto: DecideQueueDto) {
    const row = await this.database.moderationQueueItem.findUnique({
      where: { id },
      select: ROW_SELECT,
    });

    if (!row) throw ApiException.notFound('That queue item could not be found.');

    // The state of the item before the shape of the body. A reviewer whose first attempt timed out
    // and who presses the button again should learn that it landed, not be told their reason was
    // malformed — and a retry with a trimmed-down body is exactly what that looks like. Nothing
    // here mutates, so §5.9's "validate before any state changes" still holds.
    if (row.state === ModerationQueueState.RESOLVED) {
      throw ApiException.conflict(ApiErrorCode.ALREADY_DECIDED, 'That item has been decided.', {
        data: { decision: row.decision, decidedAt: row.decidedAt?.toISOString() ?? null },
      });
    }

    const reason = dto.assertReasoned();

    // Before the claim rule and before anything about the body: an item whose decision belongs
    // somewhere else is not a claiming problem. Told to claim it first, a reviewer would claim it,
    // try again, and *then* be sent to the case — two refusals for one wrong door. The work is
    // real and there is somewhere to do it, so the refusal says where.
    if (DELEGATES[row.type]) {
      throw ApiException.conflict(ApiErrorCode.INVALID_TRANSITION, DELEGATES[row.type]!, {
        data: { queueItemId: row.id, payload: row.payload ?? null },
      });
    }

    // Claim before decide, unless the caller is a lead (§5.9: they "may step in on any claim").
    if (!actor.permissions.has('moderation:assign') && row.assignedToId !== actor.id) {
      throw ApiException.conflict(
        row.assignedToId ? ApiErrorCode.CLAIMED_BY_OTHER : ApiErrorCode.CLAIM_REQUIRED,
        row.assignedToId
          ? 'Someone else is working on this.'
          : 'Claim the item before deciding it.',
        { data: { assignedToId: row.assignedToId } },
      );
    }

    const targets = await this.targets.resolve([row]);
    const target = targets.get(this.targets.key(row)) ?? null;
    const allowed = allowedDecisionsFor({
      type: row.type,
      state: row.state,
      targetType: row.targetType,
      visibilityState: target?.visibilityState ?? null,
    });

    if (!allowed.includes(dto.decision)) {
      throw ApiException.unprocessable(
        ApiErrorCode.INVALID_DECISION,
        'That decision is not available for this item.',
        { data: { allowedDecisions: allowed } },
      );
    }

    // An anonymous rejection with no words is something the author can neither fix nor argue with.
    if (
      row.type === ModerationQueueType.ANONYMOUS_POST &&
      dto.decision === ModerationDecision.REJECT &&
      !dto.memberMessage
    ) {
      throw ApiException.unprocessable(
        ApiErrorCode.MEMBER_MESSAGE_REQUIRED,
        'Tell the author why it was not approved.',
        { details: [{ field: 'memberMessage', message: 'Required when rejecting a post.' }] },
      );
    }

    // An auto-guide that cannot be published, refused **before** anything moves.
    //
    // `AutoGuideService.publish` enforces §1.8's rule — an auto-generated guide with no sources is
    // never published, whoever asks — by returning quietly. Called from here that silence is the
    // worst kind of outcome: the item resolves, the audit entry says a reviewer approved it, and
    // the guide stays unpublished with nothing anywhere saying why. So the reason is checked here
    // and the reviewer is told, which is also what §5.9 means by validating before mutating.
    if (
      row.type === ModerationQueueType.AUTO_GUIDE &&
      dto.decision === ModerationDecision.APPROVE
    ) {
      const guide = await this.database.guide.findUnique({
        where: { id: row.targetId },
        select: { isAutoGenerated: true, _count: { select: { sources: true } } },
      });

      if (!guide) {
        throw ApiException.notFound('That guide no longer exists.');
      }

      if (guide.isAutoGenerated && guide._count.sources === 0) {
        throw ApiException.unprocessable(
          ApiErrorCode.INVALID_DECISION,
          'An auto-generated guide with no sources cannot be published. Reject it instead.',
          { data: { allowedDecisions: [ModerationDecision.REJECT] } },
        );
      }
    }

    if (
      SUSPENDS.includes(dto.decision) &&
      dto.suspension?.duration === 'custom' &&
      !dto.suspension.until
    ) {
      throw ApiException.badRequest(
        ApiErrorCode.VALIDATION_FAILED,
        'A custom suspension needs an end date.',
        { details: [{ field: 'suspension.until', message: 'Required for a custom duration.' }] },
      );
    }

    const now = new Date();
    const publishing =
      dto.decision === ModerationDecision.APPROVE ||
      dto.decision === ModerationDecision.RESTORE_REACH;
    const removing = REMOVES.includes(dto.decision);
    const rejecting = dto.decision === ModerationDecision.REJECT;

    const { auditId } = await this.audit.mutate(
      {
        action: 'moderation.decided',
        targetType: 'CONTENT',
        targetId: row.targetId,
        before: { state: row.state, decision: row.decision },
        after: { state: ModerationQueueState.RESOLVED, decision: dto.decision },
        reasonCode: reason.reasonCode,
        policySubtype: reason.policySubtype,
        reason: reason.note,
        metadata: {
          queueItemId: row.id,
          queueType: row.type,
          targetType: row.targetType,
          memberMessage: dto.memberMessage ?? null,
          issueStrike: dto.issueStrike ?? true,
        },
      },
      async tx => {
        // ── 1. The content ───────────────────────────────────────────────────
        if (row.type === ModerationQueueType.AUTO_GUIDE) {
          // A draft guide is not held content: it is unpublished. Approving publishes it and
          // rejecting soft-deletes the draft, which is what `APPROVE` having no caller meant was
          // never happening.
          if (dto.decision === ModerationDecision.APPROVE) {
            await this.guides.publish(row.targetId, actor.id);
          } else if (rejecting) {
            await tx.guide.update({
              where: { id: row.targetId },
              data: { deletedAt: now, visibilityState: ContentVisibilityState.REJECTED },
            });
          }
        } else if (publishing) {
          await this.safety.applyDecision(tx, {
            targetType: row.targetType,
            targetId: row.targetId,
            state: ContentVisibilityState.VISIBLE,
            decision: dto.decision,
            reviewerId: actor.id,
          });
        } else if (rejecting) {
          await this.safety.applyDecision(tx, {
            targetType: row.targetType,
            targetId: row.targetId,
            state: ContentVisibilityState.REJECTED,
            decision: dto.decision,
            reviewerId: actor.id,
          });
        } else if (removing) {
          // The same switch the content page and the case path use. A second copy of "how does
          // each kind come down" is how one kind gets forgotten.
          await this.moderation.removeContent(tx, row.targetType, row.targetId);
          await this.safety.applyDecision(tx, {
            targetType: row.targetType,
            targetId: row.targetId,
            state: ContentVisibilityState.REJECTED,
            decision: dto.decision,
            reviewerId: actor.id,
          });
        }

        // ── 2. The lexicon's evidence ────────────────────────────────────────
        // Whether the phrases that raised this were right. The only evidence a risk term is worth
        // having, and the thing §5.13's "false positive rate" is computed from — so a decision
        // that leaves them PENDING makes the term look untested for ever.
        //
        // Only the decisions that actually judge the words. `NO_ACTION`, `ESCALATE_GUARD` and a
        // warning say something about the member rather than about the phrase — leaving the hits
        // PENDING is the honest answer, because nobody has said whether the lexicon was right.
        const verdict = publishing
          ? RiskTermHitOutcome.FALSE_POSITIVE
          : removing || rejecting
            ? RiskTermHitOutcome.CONFIRMED
            : null;

        if (verdict) {
          await tx.riskTermHit.updateMany({
            where: {
              targetType: row.targetType,
              targetId: row.targetId,
              outcome: RiskTermHitOutcome.PENDING,
            },
            data: { outcome: verdict, resolvedAt: now },
          });
        }

        // ── 3. The item ──────────────────────────────────────────────────────
        await tx.moderationQueueItem.update({
          where: { id },
          data: {
            state: ModerationQueueState.RESOLVED,
            decision: dto.decision,
            decisionNote: reason.note,
            decidedById: actor.id,
            decidedAt: now,
            // A decide on an unclaimed item records the decider as the assignee (§5.9), so the
            // trail answers "who had this" as well as "who decided it".
            assignedToId: row.assignedToId ?? actor.id,
          },
        });

        // ── 4. The linked report, if this came from one ──────────────────────
        if (row.reportId) {
          await tx.report.updateMany({
            where: { id: row.reportId },
            data: {
              state: dto.decision === ModerationDecision.NO_ACTION ? 'DISMISSED' : 'ACTIONED',
              decision: dto.decision,
              decisionNote: reason.note,
              reviewedById: actor.id,
              reviewedAt: now,
            },
          });
        }

        // ── 5. The append-only record ────────────────────────────────────────
        await tx.moderationAction.create({
          data: {
            actorId: actor.id,
            targetType: row.targetType,
            targetId: row.targetId,
            decision: dto.decision,
            reason: reason.note,
            metadata: { queueItemId: row.id, queueType: row.type },
          },
        });
      },
    );

    // ── Outside the transaction ──────────────────────────────────────────────
    // Enforcement and notifications both reach Redis, email and FCM. A rolled-back transaction
    // cannot un-send an email, and a decision half-applied because a notification failed is worse
    // than one a manager has to finish by hand.
    await this.enforcement.apply({
      targetUserId: row.subjectUserId,
      decision: dto.decision,
      issueStrike: dto.issueStrike,
      memberMessage: dto.memberMessage,
      suspension: dto.suspension,
      reason,
      sourceType: EnforcementSourceType.CONTENT,
      sourceId: row.id,
      describedBy: `Queue item ${row.id}`,
    });

    // Guard, when that is what was decided. `dto.guard` was accepted and validated by the DTO and
    // then read by nothing at all: staff escalated an item, supplied a category and a note, got a
    // 200, and no case opened. The decision was recorded, which is what made it invisible.
    if (dto.decision === ModerationDecision.ESCALATE_GUARD) {
      if (!row.subjectUserId) {
        this.logger.warn(
          `Queue item ${row.id} escalated to Guard with no author to open a thread with.`,
        );
      } else {
        try {
          await this.guard.escalate(actor, {
            memberId: row.subjectUserId,
            // Member-visible, as the private thread's subtitle — so it names the conversation,
            // not the queue item behind it.
            subject: GUARD_ESCALATION_SUBJECT,
            categoryCode: dto.guard?.categoryCode ?? null,
            source: GuardCaseSource.ESCALATION,
            sourceId: row.id,
            reason: { ...reason, note: dto.guard?.note ?? reason.note },
          });
        } catch (error) {
          // Loudly: an escalation that silently failed to open is exactly the failure this path
          // was added to end.
          this.logger.error(
            `Queue item ${row.id} decided ESCALATE_GUARD but the Guard case did not open: ${
              (error as Error).message
            }`,
          );
        }
      }
    }

    // The author is told when the decision changes what they can see of their own content. Not on
    // `NO_ACTION`, and not on a removal that already warned them — `enforcement.apply` sent that.
    if (rejecting && row.subjectUserId && dto.memberMessage) {
      this.actions.notifyMember(row.subjectUserId, {
        title: 'Your post was not approved',
        body: dto.memberMessage,
      });
    }

    if (
      dto.decision === ModerationDecision.APPROVE &&
      row.subjectUserId &&
      row.type === ModerationQueueType.ANONYMOUS_POST
    ) {
      this.actions.notifyMember(row.subjectUserId, {
        title: 'Your anonymous post is live',
        body: 'Somebody from our team read it and published it.',
      });
    }

    return {
      data: await this.detail(id),
      meta: { auditId, ...(await this.enforcement.aftermath(row.subjectUserId)) },
    };
  }

  // ─── Who holds what ────────────────────────────────────────────────────────

  /**
   * Takes the item.
   *
   * Claiming an `APPEAL` item also moves its `Appeal` to `IN_REVIEW` with the same reviewer: one
   * claim, kept in sync, because two rows disagreeing about who is reviewing an appeal is how R6
   * gets checked against the wrong person.
   */
  async claim(actor: AdminPrincipal, id: string) {
    const row = await this.liveOrThrow(id);

    if (row.assignedToId && row.assignedToId !== actor.id) {
      throw ApiException.conflict(
        ApiErrorCode.CLAIMED_BY_OTHER,
        'Someone else is already working on this.',
        { data: { assignedToId: row.assignedToId } },
      );
    }

    await this.assertNotTheOriginalDecider(actor, row);

    const { auditId } = await this.audit.mutate(
      {
        action: 'moderation.claimed',
        targetType: 'CONTENT',
        targetId: row.targetId,
        before: { assignedToId: row.assignedToId, state: row.state },
        after: { assignedToId: actor.id, state: ModerationQueueState.IN_REVIEW },
        metadata: { queueItemId: row.id, queueType: row.type },
      },
      async tx => {
        await tx.moderationQueueItem.update({
          where: { id },
          data: { assignedToId: actor.id, state: ModerationQueueState.IN_REVIEW },
        });

        await this.syncAppeal(tx, row, { reviewerId: actor.id, state: 'IN_REVIEW' });
      },
    );

    void auditId;

    return this.detail(id);
  }

  /**
   * Puts it back on the pile.
   *
   * Your own claim, or anybody's if you hold `moderation:assign`. Not "anybody's claim for
   * anyone", because releasing somebody else's work mid-review is the same interruption a stolen
   * claim would be, and the permission that allows it is the one that exists for stepping in.
   *
   * An `APPEAL` item's appeal returns to `OPEN` with no reviewer — otherwise the appeal still
   * names somebody who has walked away from it, and R6 would later refuse the only person who
   * could pick it up.
   */
  async release(actor: AdminPrincipal, id: string) {
    const row = await this.database.moderationQueueItem.findUnique({
      where: { id },
      select: ROW_SELECT,
    });

    if (!row) throw ApiException.notFound('That queue item could not be found.');

    if (row.state === ModerationQueueState.RESOLVED) {
      throw ApiException.conflict(ApiErrorCode.ALREADY_DECIDED, 'That item has been decided.', {
        data: { decision: row.decision, decidedAt: row.decidedAt?.toISOString() ?? null },
      });
    }

    if (row.assignedToId !== actor.id && !actor.permissions.has('moderation:assign')) {
      throw ApiException.forbidden(
        ApiErrorCode.FORBIDDEN,
        row.assignedToId ? 'That is somebody else’s claim.' : 'Nobody is holding that item.',
      );
    }

    await this.audit.mutate(
      {
        action: 'moderation.released',
        targetType: 'CONTENT',
        targetId: row.targetId,
        before: { assignedToId: row.assignedToId, state: row.state },
        after: { assignedToId: null, state: ModerationQueueState.PENDING },
        metadata: { queueItemId: row.id, queueType: row.type },
      },
      async tx => {
        await tx.moderationQueueItem.update({
          where: { id },
          data: { assignedToId: null, state: ModerationQueueState.PENDING },
        });

        await this.syncAppeal(tx, row, { reviewerId: null, state: 'OPEN' });
      },
    );

    return this.detail(id);
  }

  /**
   * Gives it to somebody, or returns it to the pool.
   *
   * Only `moderation:assign` holders (manager, super admin) may hand work to another person;
   * reviewers take work with `claim`. The assignee has to be able to *do* it, which is checked
   * here rather than discovered at decide time by somebody who cannot press the button.
   */
  async assign(actor: AdminPrincipal, id: string, assigneeId: string | null) {
    if (!actor.permissions.has('moderation:assign')) {
      throw ApiException.forbidden(
        ApiErrorCode.FORBIDDEN,
        'Only leads assign work. Claim it instead.',
      );
    }

    const row = await this.liveOrThrow(id);

    if (assigneeId) {
      // `guard:manage` as well as `moderation:decide`, because a GUARD_RISK item is safeguarding
      // work and the Guard team holds that permission rather than the moderation one.
      const needed =
        row.type === ModerationQueueType.GUARD_RISK
          ? ['moderation:decide', 'guard:manage']
          : ['moderation:decide'];

      await this.assignees.assertHolds(assigneeId, needed, 'assigneeId');
      await this.assertNotTheOriginalDecider({ id: assigneeId, permissions: new Set() }, row);
    }

    await this.audit.mutate(
      {
        action: 'moderation.assigned',
        targetType: 'CONTENT',
        targetId: row.targetId,
        before: { assignedToId: row.assignedToId },
        after: { assignedToId: assigneeId },
        metadata: { queueItemId: row.id, queueType: row.type },
      },
      async tx => {
        await tx.moderationQueueItem.update({
          where: { id },
          data: {
            assignedToId: assigneeId,
            state: assigneeId ? ModerationQueueState.IN_REVIEW : ModerationQueueState.PENDING,
          },
        });

        await this.syncAppeal(tx, row, {
          reviewerId: assigneeId,
          state: assigneeId ? 'IN_REVIEW' : 'OPEN',
        });
      },
    );

    return this.detail(id);
  }

  private async liveOrThrow(id: string) {
    const row = await this.database.moderationQueueItem.findUnique({
      where: { id },
      select: ROW_SELECT,
    });

    if (!row) throw ApiException.notFound('That queue item could not be found.');

    if (row.state === ModerationQueueState.RESOLVED) {
      throw ApiException.conflict(ApiErrorCode.ALREADY_DECIDED, 'That item has been decided.', {
        data: { decision: row.decision, decidedAt: row.decidedAt?.toISOString() ?? null },
      });
    }

    return row;
  }

  /** The assignee must be able to finish what they are being given. */
  /**
   * R6, at claim and at assign rather than only at decide (§5.9).
   *
   * Finding out that you cannot review an appeal *after* reading the member's argument about your
   * own decision is too late to be impartial about it.
   */
  private async assertNotTheOriginalDecider(
    actor: Pick<AdminPrincipal, 'id'> & { permissions: Set<string> },
    row: QueueRow,
  ) {
    if (row.type !== ModerationQueueType.APPEAL) return;

    const appealId = (row.payload as { appealId?: string } | null)?.appealId;

    if (!appealId) return;

    const appeal = await this.database.appeal.findUnique({
      where: { id: appealId },
      select: { originalDeciderId: true },
    });

    if (appeal?.originalDeciderId && appeal.originalDeciderId === actor.id) {
      throw ApiException.forbidden(
        ApiErrorCode.APPEAL_REVIEWER_CONFLICT,
        'You took the original decision, so you cannot review the appeal against it.',
      );
    }
  }

  /**
   * Keeps an `APPEAL` item and its `Appeal` row saying the same thing.
   *
   * Two rows that disagree about who is reviewing an appeal is not a cosmetic problem: R6 is
   * checked against `Appeal.reviewerId`, so a claim recorded on only one of them lets the original
   * decider review their own decision through the other door.
   */
  private async syncAppeal(
    tx: Prisma.TransactionClient,
    row: QueueRow,
    next: { reviewerId: string | null; state: 'OPEN' | 'IN_REVIEW' },
  ) {
    if (row.type !== ModerationQueueType.APPEAL) return;

    const appealId = (row.payload as { appealId?: string } | null)?.appealId;

    if (!appealId) return;

    await tx.appeal.updateMany({
      // Only while it is still open work. An appeal somebody has decided is not reopened by
      // releasing the queue item that led to it.
      where: { id: appealId, state: { in: [AppealState.OPEN, AppealState.IN_REVIEW] } },
      data: {
        reviewerId: next.reviewerId,
        state: next.state === 'OPEN' ? AppealState.OPEN : AppealState.IN_REVIEW,
      },
    });
  }

  // ─── Plumbing ──────────────────────────────────────────────────────────────

  /**
   * Band first, then closest to breaching, then oldest.
   *
   * `priority` is a Postgres enum whose declaration order is NORMAL, HIGH, URGENT, so `desc` puts
   * urgent first — which is why this does not sort on a computed weight. The enum's order is the
   * contract; `PRIORITY_RANK` exists for the places that cannot use a database sort.
   */
  private orderFor(
    sort: ListQueueItemsDto['sort'],
    order: ListQueueItemsDto['order'],
  ): Prisma.ModerationQueueItemOrderByWithRelationInput[] {
    const direction = order ?? 'asc';

    switch (sort) {
      case 'dueAt':
        return [{ dueAt: direction }, { createdAt: 'asc' }];
      case 'createdAt':
        return [{ createdAt: direction }];
      default:
        return [{ priority: 'desc' }, { dueAt: 'asc' }, { createdAt: 'asc' }];
    }
  }

  /**
   * How many people reported each target.
   *
   * Counted off `Report`, not off the item's single `reportId`. The old row said `1` for a post
   * twelve people had reported, which is the number a reviewer uses to decide what to open first.
   */
  private async reportCounts(rows: QueueRow[]): Promise<Map<string, number>> {
    const reportable = rows.filter(row => row.reportId);

    if (!reportable.length) return new Map();

    const grouped = await this.database.report.groupBy({
      by: ['targetType', 'targetId'],
      _count: { id: true },
      where: {
        OR: reportable.map(row => ({ targetType: row.targetType, targetId: row.targetId })),
      },
    });

    return new Map(grouped.map(row => [`${row.targetType}:${row.targetId}`, row._count.id]));
  }

  /** The scan tier per target, for the one filter that cannot be a `where`. */
  private async tiersFor(rows: QueueRow[]) {
    if (!rows.length) return new Map<string, ContentRiskTier>();

    const safety = await this.database.contentSafety.findMany({
      where: { OR: rows.map(row => ({ targetType: row.targetType, targetId: row.targetId })) },
      select: { targetType: true, targetId: true, tier: true },
    });

    return new Map(safety.map(row => [`${row.targetType}:${row.targetId}`, row.tier]));
  }

  private async countsByType(): Promise<Record<string, number>> {
    const grouped = await this.database.moderationQueueItem.groupBy({
      by: ['type'],
      _count: { id: true },
      where: { state: { in: OPEN_QUEUE_STATES } },
    });
    const counts: Record<string, number> = {};

    for (const type of Object.values(ModerationQueueType)) counts[type] = 0;
    for (const row of grouped) counts[row.type] = row._count.id;

    return counts;
  }

  /** What else is known about the person this is about, so a decision is proportionate. */
  private async authorHistory(userId: string) {
    const now = new Date();
    const [strikes, activeStrikes, priorReports, priorRemovals, suspensions, user] =
      await Promise.all([
        this.database.strike.findMany({
          where: { userId },
          orderBy: { issuedAt: 'desc' },
          take: 10,
          select: {
            id: true,
            reasonCode: true,
            policySubtype: true,
            note: true,
            issuedAt: true,
            expiresAt: true,
            revokedAt: true,
          },
        }),
        this.database.strike.count({
          where: { userId, revokedAt: null, expiresAt: { gt: now } },
        }),
        this.database.report.count({ where: { targetUserId: userId } }),
        this.database.moderationAction.count({
          where: { targetId: userId, decision: { in: ['REMOVE_CONTENT', 'REMOVE_AND_WARN'] } },
        }),
        this.database.suspension.count({ where: { userId } }),
        this.database.user.findUnique({ where: { id: userId }, select: { createdAt: true } }),
      ]);

    return {
      activeStrikes,
      strikes: strikes.map(strike => ({
        id: strike.id,
        reasonCode: strike.reasonCode,
        policySubtype: strike.policySubtype,
        note: strike.note,
        issuedAt: strike.issuedAt.toISOString(),
        expiresAt: strike.expiresAt.toISOString(),
        revokedAt: strike.revokedAt?.toISOString() ?? null,
        isActive: !strike.revokedAt && strike.expiresAt > now,
      })),
      priorReports,
      priorRemovals,
      suspensions,
      accountAgeDays: user
        ? Math.floor((now.getTime() - user.createdAt.getTime()) / 86_400_000)
        : null,
    };
  }

  /** Every decision taken about this target, newest first. */
  private async historyFor(row: QueueRow) {
    const actions = await this.database.moderationAction.findMany({
      where: { targetType: row.targetType, targetId: row.targetId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const actors = await this.database.user.findMany({
      where: { id: { in: [...new Set(actions.map(action => action.actorId))] } },
      select: staffRefSelect,
    });
    const byId = new Map(actors.map(actor => [actor.id, actor]));

    return actions.map(action => ({
      id: action.id,
      decision: action.decision,
      reason: action.reason,
      at: action.createdAt.toISOString(),
      // Resolved from the live row rather than joined: the table deliberately holds no foreign key
      // to the user, so a decision survives the deletion of the account that made it.
      actor: byId.has(action.actorId)
        ? toStaffRef(byId.get(action.actorId)!, this.media.sign)
        : null,
    }));
  }

  private toRow(
    row: QueueRow,
    target: ContentTargetView | null,
    reportCounts: Map<string, number>,
    now: Date,
  ) {
    return {
      id: row.id,
      type: row.type,
      state: row.state,
      priority: row.priority,
      dueAt: row.dueAt.toISOString(),
      overdue: row.state !== ModerationQueueState.RESOLVED && row.dueAt < now,
      content: target
        ? {
            targetType: target.targetType,
            targetId: target.targetId,
            title: target.title,
            removed: target.removed,
            visibilityState: target.visibilityState,
            conversationId: target.conversationId,
          }
        : // A target with no content row: a member, a conversation, or content that is gone. The
          // ids are still returned, because the reviewer still has to be able to open it.
          { targetType: row.targetType, targetId: row.targetId, title: null, removed: true },
      risk: {
        level: row.riskLevel,
        category: row.riskCategory,
        score: row.riskScore,
        // The matched phrases, so "why was this raised" has an answer a reviewer can read rather
        // than a number they have to trust.
        signals: row.riskSignals ?? [],
      },
      subject: row.subjectUser ? toMemberRef(row.subjectUser, this.media.sign) : null,
      assignedTo: row.assignedTo ? toStaffRef(row.assignedTo, this.media.sign) : null,
      reportCount: reportCounts.get(this.targets.key(row)) ?? 0,
      summary: row.summary,
      decision: row.decision,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      /**
       * The buttons. Returned rather than inferred, because the rules are §6.6's and a copy in the
       * portal is a copy that will offer `APPROVE` on something nobody held.
       */
      allowedDecisions: allowedDecisionsFor({
        type: row.type,
        state: row.state,
        targetType: row.targetType,
        visibilityState: target?.visibilityState ?? null,
      }),
    };
  }
}

/**
 * Where the decision for these two actually lives.
 *
 * Both have their own endpoint with its own rules, permissions and side effects, so `allowedDecisions`
 * is empty for them — and an empty list with no explanation is a dead end on a screen. This is the
 * explanation.
 */
const DELEGATES: Partial<Record<ModerationQueueType, string>> = {
  [ModerationQueueType.REPORTED_CONTENT]:
    'Decide this on the report case: POST admin/reports/cases/:id/decide.',
  [ModerationQueueType.APPEAL]: 'Decide this on the appeal: POST admin/appeals/:id/decide.',
  [ModerationQueueType.PROFESSIONAL_REVIEW]:
    'Decide this on the professional review: POST admin/professional-reviews/:id/decide.',
};

/** The bands at or above this one, for `minRiskLevel`. */
const RANK: Record<RiskLevel, number> = {
  [RiskLevel.NONE]: 0,
  [RiskLevel.LOW]: 1,
  [RiskLevel.MEDIUM]: 2,
  [RiskLevel.HIGH]: 3,
  [RiskLevel.CRITICAL]: 4,
};

const atOrAbove = (level: RiskLevel): RiskLevel[] =>
  (Object.keys(RANK) as RiskLevel[]).filter(candidate => RANK[candidate] >= RANK[level]);
