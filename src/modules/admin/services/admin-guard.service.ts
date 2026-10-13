import { Injectable } from '@nestjs/common';
import {
  AdminReasonCode,
  GuardCaseSource,
  GuardThreadState,
  NoteSubjectType,
  Prisma,
  ReportTargetType,
  RiskLevel,
  TaxonomyKind,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException, buildPageMeta } from '@/common';
import { MediaService, TaxonomyService } from '@/modules/platform/shared';
import { ConversationFactoryService } from '@/modules/platform/messaging';
import { GuardService } from '@/modules/platform/guard';
import { AuditService } from '../audit/audit.service';
import { AdminPrincipal } from '../common/admin-principal';
import {
  CreateGuardCaseDto,
  ListGuardCasesDto,
  OPEN_GUARD_STATES,
  UpdateGuardCaseDto,
} from '../dtos/admin-guard.dto';
import { staffRefSelect, toStaffRef } from '../serializers/admin-staff.serializer';
import { toMemberRef } from '../serializers/admin-member.serializer';
import { caseMemberSelect } from '../serializers/admin-report-case.serializer';
import { contentAdminUrl } from '../serializers/admin-url';
import { AdminAssigneeService } from './admin-assignee.service';
import { AdminHistoryService } from './admin-history.service';

const RISK_ORDER: RiskLevel[] = [
  RiskLevel.CRITICAL,
  RiskLevel.HIGH,
  RiskLevel.MEDIUM,
  RiskLevel.LOW,
  RiskLevel.NONE,
];

/**
 * The subject a staff-raised Guard case opens with, when staff did not choose one.
 *
 * Member-visible: it becomes the private thread's subtitle. So it names the conversation and not
 * whatever caused it — a subject reading "escalated from report 4f2b" would tell the member a
 * report exists, which §7.3 keeps from them.
 */
export const GUARD_ESCALATION_SUBJECT = 'Something we would like to talk to you about';

/** What `sourceType: 'CONTENT' | 'REPORT_CASE' | 'ESCALATION'` records on the row (§5.12). */
const SOURCE_OF: Record<CreateGuardCaseDto['sourceType'], GuardCaseSource> = {
  REPORT_CASE: GuardCaseSource.REPORT,
  CONTENT: GuardCaseSource.ESCALATION,
  ESCALATION: GuardCaseSource.ESCALATION,
};

/** The Guard case queue, kept separate from ordinary moderation. */
@Injectable()
export class AdminGuardService {
  constructor(
    private readonly database: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly conversations: ConversationFactoryService,
    private readonly media: MediaService,
    private readonly audit: AuditService,
    private readonly assignees: AdminAssigneeService,
    private readonly history: AdminHistoryService,
    private readonly guard: GuardService,
  ) {}

  // ─── Read ──────────────────────────────────────────────────────────────────

  async list(actor: AdminPrincipal, query: ListGuardCasesDto) {
    const where = this.scope(actor, query);
    const sort = query.sortField(['risk', 'createdAt', 'updatedAt'], 'risk');
    const direction = query.order ?? 'desc';

    const [total, rows, categoryLabels, urgentCount] = await Promise.all([
      this.database.guardThread.count({ where }),
      this.database.guardThread.findMany({
        where,
        include: {
          // `caseMemberSelect` and `staffRefSelect`: the two shapes §5.0 asks for, rather than
          // the member app's author view, which has no `status` and no surname.
          user: { select: caseMemberSelect },
          assignedTo: { select: staffRefSelect },
        },
        orderBy:
          sort === 'risk'
            ? // Urgency first, always. This ordering is the product promise.
              [{ riskLevel: 'desc' }, { riskScore: 'desc' }, { createdAt: 'asc' }]
            : [{ [sort]: direction }],
        skip: (query.currentPage - 1) * query.size,
        take: query.size,
      }),
      // GUARD_CATEGORY, not COMMUNITY_CATEGORY (B28). The codes a Guard case carries are
      // HOUSING, IMMIGRATION, SAFETY, MONEY, HEALTH, WORK, OTHER — looked up in the community
      // vocabulary they all missed, so every case rendered its own raw code as its label.
      this.taxonomy.labels(TaxonomyKind.GUARD_CATEGORY),
      this.database.guardThread.count({
        where: {
          state: { in: OPEN_GUARD_STATES },
          riskLevel: { in: [RiskLevel.HIGH, RiskLevel.CRITICAL] },
        },
      }),
    ]);

    const now = Date.now();

    return {
      data: rows.map(row => this.toRow(row, categoryLabels, now)),
      // The number that should never sit.
      meta: buildPageMeta({ currentPage: query.currentPage, perPage: query.size }, total, {
        urgentCount,
      }),
    };
  }

  async findOne(id: string) {
    const thread = await this.database.guardThread.findUnique({
      where: { id },
      include: { user: { select: caseMemberSelect }, assignedTo: { select: staffRefSelect } },
    });

    if (!thread) throw ApiException.notFound('That case could not be found.');

    const [categoryLabels, notes, history, linkedContent] = await Promise.all([
      this.taxonomy.labels(TaxonomyKind.GUARD_CATEGORY),
      this.notesFor(thread.id),
      // The conversation is the case's target, so its history is what was decided about the
      // thread rather than about a post.
      this.history.forTarget(ReportTargetType.CONVERSATION, thread.conversationId ?? thread.id),
      this.linkedContentFor(thread),
    ]);

    return {
      ...this.toRow(thread, categoryLabels, Date.now()),
      linkedContent,
      notes,
      history,
    };
  }

  // ─── Write ─────────────────────────────────────────────────────────────────

  /**
   * Assign or move a case, and record that somebody did (§5.12).
   *
   * This used to end in `void adminId` — the parameter was taken, named, and thrown away, so a
   * case could be closed and reassigned with nothing anywhere saying who did it. That is the one
   * thing an audit trail on safeguarding work exists for.
   */
  async update(actor: AdminPrincipal, id: string, dto: UpdateGuardCaseDto) {
    const thread = await this.database.guardThread.findUnique({ where: { id } });

    if (!thread) throw ApiException.notFound('That case could not be found.');

    if (dto.state === undefined && dto.assignedToId === undefined && !dto.note) {
      throw ApiException.badRequest(
        ApiErrorCode.VALIDATION_FAILED,
        'Say what to change: a state, an assignee, or a note.',
      );
    }

    const assignedToId = dto.assignedToId === undefined ? thread.assignedToId : dto.assignedToId;
    const state = dto.state ?? thread.state;

    // A body that asks for what is already true. Returned as a 200 with no history and no audit
    // entry, per §5.12: a trail where every poll from the portal looks like a decision is a trail
    // nobody can read. A note is never a no-op — writing one is the change.
    if (state === thread.state && assignedToId === thread.assignedToId && !dto.note) {
      return { data: await this.findOne(id) };
    }

    if (assignedToId && assignedToId !== thread.assignedToId) {
      // Safeguarding work needs `guard:manage` to clear, so it may only be handed to somebody who
      // holds it. `guard:read` would put the case in a queue they cannot work while it stopped
      // reading as unassigned to everybody who could.
      await this.assignees.assertHolds(assignedToId, ['guard:manage'], 'assignedToId');
    }

    // A note-only change is **not** refused for want of a reason code (§5.12: the body is
    // `Partial<Reasoned>`). The note is the record — "spoke to her, she is safe for now" is the
    // whole point of writing it — and demanding a code beside it meant adding a note to a Guard
    // case answered `422 REASON_REQUIRED`, so the one thing a reviewer does most often could not
    // be done at all. A code is still honoured when sent, and still demanded where the change is
    // a state transition rather than a note.
    const reason = dto.reasonCode ? dto.assertReasoned() : null;
    const resolving =
      state !== thread.state &&
      (state === GuardThreadState.RESOLVED || state === GuardThreadState.CLOSED);

    const { auditId } = await this.audit.mutate(
      {
        action: 'guard.case_updated',
        targetType: 'CONVERSATION',
        targetId: thread.conversationId ?? thread.id,
        targetLabel: thread.subject,
        before: { state: thread.state, assignedToId: thread.assignedToId },
        after: { state, assignedToId },
        reasonCode: reason?.reasonCode,
        policySubtype: reason?.policySubtype,
        // The note, whether or not a code came with it — otherwise a note-only change records the
        // state it moved to and not the sentence explaining why, which is the half worth keeping.
        reason: reason?.note ?? dto.note?.trim() ?? null,
        metadata: { guardThreadId: thread.id },
      },
      async tx => {
        await tx.guardThread.update({
          where: { id },
          data: {
            state,
            assignedToId,
            // Stamped when it closes, and cleared when it reopens: a resolved date on an open
            // case is how a queue comes to disagree with its own SLA.
            ...(resolving ? { resolvedAt: new Date() } : {}),
            ...(state === GuardThreadState.OPEN || state === GuardThreadState.IN_PROGRESS
              ? { resolvedAt: null }
              : {}),
          },
        });

        if (dto.note) {
          await tx.internalNote.create({
            data: {
              subjectType: NoteSubjectType.GUARD_CASE,
              subjectId: thread.id,
              authorId: actor.id,
              body: dto.note,
            },
          });
        }
      },
    );

    // Outside the transaction: joining the thread writes to the conversation, and a failure there
    // must not undo the assignment it followed.
    if (assignedToId && thread.conversationId) {
      await this.conversations.addStaff(thread.conversationId, [assignedToId]);
    }

    return { data: await this.findOne(id), auditId };
  }

  /**
   * Open a case because staff decided to (§5.12).
   *
   * The thread itself is opened by `GuardService`, which is where D36's "one private thread per
   * member" rule lives. This adds the two things that are the admin API's own: the audit entry,
   * and refusing to open a case about a staff account.
   */
  async create(actor: AdminPrincipal, dto: CreateGuardCaseDto) {
    const member = await this.database.user.findUnique({
      where: { id: dto.memberId },
      select: { id: true, isStaff: true, deletedAt: true, anonymisedAt: true },
    });

    if (!member || member.deletedAt || member.anonymisedAt) {
      throw ApiException.notFound('That member could not be found.');
    }

    if (member.isStaff) {
      throw ApiException.badRequest(
        ApiErrorCode.VALIDATION_FAILED,
        'Guard cases are about members. Raise a staff concern through your lead.',
        { details: [{ field: 'memberId', message: 'That is a staff account.' }] },
      );
    }

    const reason = dto.assertReasoned();
    const opened = await this.escalate(actor, {
      memberId: dto.memberId,
      subject: dto.subject,
      categoryCode: dto.categoryCode ?? null,
      source: SOURCE_OF[dto.sourceType],
      sourceId: dto.sourceId,
      riskLevel: dto.riskLevel ?? null,
      reason,
    });

    return { data: await this.findOne(opened.guardThreadId), auditId: opened.auditId };
  }

  /**
   * Open a Guard case off a decision taken somewhere else (`ESCALATE_GUARD`).
   *
   * Called by the moderation queue and the report case service, which both offer staff an
   * `ESCALATE_GUARD` decision. Until this existed, both of them recorded that decision and
   * stopped: the queue even accepted a `guard: { categoryCode, note }` body, validated it, and
   * then read it nowhere. Staff escalated, got a 200, and no case opened — the worst shape a
   * safeguarding failure can take, because everything says it worked.
   *
   * Returns the ids rather than the case so a caller can put them in its own response without a
   * second read.
   */
  async escalate(
    actor: AdminPrincipal,
    input: {
      memberId: string;
      subject: string;
      categoryCode?: string | null;
      source: GuardCaseSource;
      sourceId: string | null;
      riskLevel?: RiskLevel | null;
      reason: { reasonCode: AdminReasonCode; policySubtype: string | null; note: string | null };
    },
  ) {
    const opened = await this.guard.openForStaff({
      memberId: input.memberId,
      subject: input.subject,
      categoryCode: input.categoryCode ?? null,
      sourceType: input.source,
      sourceId: input.sourceId,
      riskLevel: input.riskLevel ?? null,
    });

    // Recorded after the fact rather than inside the thread's transaction, because that
    // transaction belongs to the member module and wrapping it would make the admin API's audit
    // trail a reason a member's safeguarding thread failed to open.
    const auditId = await this.audit.note({
      action: 'guard.case_created',
      targetType: 'CONVERSATION',
      targetId: opened.conversationId,
      targetLabel: input.subject,
      after: {
        guardThreadId: opened.thread.id,
        source: input.source,
        sourceId: input.sourceId,
        reopened: opened.reopened,
      },
      reasonCode: input.reason.reasonCode,
      policySubtype: input.reason.policySubtype,
      reason: input.reason.note,
      actorId: actor.id,
    });

    return {
      guardThreadId: opened.thread.id,
      conversationId: opened.conversationId,
      reopened: opened.reopened,
      auditId,
    };
  }

  // ─── Shapes ────────────────────────────────────────────────────────────────

  private scope(actor: AdminPrincipal, query: ListGuardCasesDto): Prisma.GuardThreadWhereInput {
    const states = (query.state ?? []).filter(state => state !== 'ALL') as GuardThreadState[];
    const lifted = (query.state ?? []).includes('ALL');

    return {
      ...(lifted ? {} : { state: { in: states.length ? states : OPEN_GUARD_STATES } }),
      // Both bands: `level` is the exact set the portal's chips send, `minRiskLevel` the
      // "at or above" the member-facing list has always sent. Together rather than either/or, so
      // a caller sending both gets the intersection instead of one silently winning.
      ...(query.level?.length ? { riskLevel: { in: query.level } } : {}),
      ...(query.minRiskLevel
        ? {
            riskLevel: {
              in: RISK_ORDER.slice(0, RISK_ORDER.indexOf(query.minRiskLevel) + 1).filter(
                level => !query.level?.length || query.level.includes(level),
              ),
            },
          }
        : {}),
      ...(query.source?.length ? { sourceType: { in: query.source } } : {}),
      ...(query.category ? { categoryCode: query.category } : {}),
      ...(query.mine ? { assignedToId: actor.id } : {}),
      ...(query.assignedToId && !query.mine ? { assignedToId: query.assignedToId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lt: new Date(query.to) } : {}),
            },
          }
        : {}),
      ...(query.q ? { subject: { contains: query.q, mode: 'insensitive' as const } } : {}),
    };
  }

  private toRow(
    row: Prisma.GuardThreadGetPayload<{
      include: {
        user: { select: typeof caseMemberSelect };
        assignedTo: { select: typeof staffRefSelect };
      };
    }>,
    categoryLabels: Map<string, string>,
    now: number,
  ) {
    const open = OPEN_GUARD_STATES.includes(row.state);

    return {
      id: row.id,
      subject: row.subject,
      category: row.categoryCode
        ? {
            code: row.categoryCode,
            label: categoryLabels.get(row.categoryCode) ?? row.categoryCode,
          }
        : null,
      state: row.state,
      // `MemberRef` and `StaffRef` (§5.0), not the member app's author view. The two differ in
      // exactly the way that broke the portal's cards: an author view has `displayName` and no
      // `firstName`/`lastName`, so a safeguarding case showed a blank where the member's name
      // should be — and the one place a reviewer must be certain who they are reading about.
      member: toMemberRef(row.user, this.media.sign),
      assignedTo: row.assignedTo ? toStaffRef(row.assignedTo, this.media.sign) : null,
      risk: {
        level: row.riskLevel,
        category: row.riskCategory,
        score: row.riskScore,
        signals: row.riskSignals ?? [],
      },
      conversationId: row.conversationId,
      source: row.sourceType,
      // **Frozen at the close, not zeroed** (§12). It stops climbing — an age that keeps rising
      // after a case is answered makes every old case look like a failure — but zero says the case
      // was handled instantly, which is the opposite of the truth and is the number a lead would
      // quote. Where a closed case has no `resolvedAt` (it predates the column) the age is what it
      // was at the last update.
      slaAgeMinutes: Math.max(
        0,
        Math.round(
          ((open ? now : (row.resolvedAt ?? row.updatedAt).getTime()) - row.createdAt.getTime()) /
            60_000,
        ),
      ),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async notesFor(guardThreadId: string) {
    const rows = await this.database.internalNote.findMany({
      where: {
        subjectType: NoteSubjectType.GUARD_CASE,
        subjectId: guardThreadId,
        deletedAt: null,
      },
      orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    });

    const authors = await this.database.user.findMany({
      where: { id: { in: [...new Set(rows.map(row => row.authorId))] } },
      select: staffRefSelect,
    });
    const byId = new Map(authors.map(person => [person.id, person]));

    return rows.map(row => ({
      id: row.id,
      body: row.body,
      author: byId.has(row.authorId) ? toStaffRef(byId.get(row.authorId)!, this.media.sign) : null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * What this case was raised about, when it was raised about something (§5.12).
   *
   * Only the staff-raised sources have a referent: a member opening a thread is not about a
   * particular post, and inventing a link from the risk signals would be a guess rendered as a
   * fact in a safeguarding file.
   */
  private async linkedContentFor(row: { sourceType: GuardCaseSource; sourceId: string | null }) {
    if (!row.sourceId || row.sourceType === GuardCaseSource.MEMBER) return [];

    if (row.sourceType === GuardCaseSource.REPORT) {
      const kase = await this.database.reportCase.findUnique({
        where: { id: row.sourceId },
        select: { id: true, targetType: true, targetId: true },
      });

      return kase
        ? [
            {
              // `targetType`/`targetId` and a link, as every other content reference on this
              // surface spells them (§5.0's `ContentRef`). It was `{ type, id }`, which the
              // portal's content card cannot read — so a safeguarding case linked to a post and
              // showed nothing.
              targetType: kase.targetType,
              targetId: kase.targetId,
              adminUrl: contentAdminUrl(kase.targetType, kase.targetId),
              reportCaseId: kase.id,
            },
          ]
        : // The case was deleted after the escalation. An empty list rather than a dangling
          // reference the portal would render as a dead link.
          [];
    }

    const item = await this.database.moderationQueueItem.findUnique({
      where: { id: row.sourceId },
      select: { targetType: true, targetId: true },
    });

    return item
      ? [
          {
            targetType: item.targetType,
            targetId: item.targetId,
            adminUrl: contentAdminUrl(item.targetType, item.targetId),
            reportCaseId: null,
          },
        ]
      : [];
  }
}
