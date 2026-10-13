import { Injectable, Logger } from '@nestjs/common';
import {
  CannedReply,
  NoteSubjectType,
  ParticipantRole,
  Prisma,
  SupportThreadState,
  SupportThreadType,
  SystemMessageType,
  ThreadContextType,
  ThreadKind,
} from '@prisma/client';
import { ApiErrorCode, ApiException, SYSTEM_CONFIG_KEYS, buildPageMeta } from '@/common';
import { PrismaService } from '@/infrastructure';
import { MediaService, SystemConfigService } from '@/modules/platform/shared';
import {
  ConversationFactoryService,
  ListMessagesDto,
  MessageService,
  waitingSince,
} from '@/modules/platform/messaging';
import { AuditService } from '../audit/audit.service';
import { AdminPolicyService } from '../common/admin-policy.service';
import { AdminPrincipal } from '../common/admin-principal';
import {
  AssignSupportThreadDto,
  CreateCannedReplyDto,
  ListCannedRepliesDto,
  ListSupportThreadsDto,
  OPEN_SUPPORT_STATES,
  PatchCannedReplyDto,
  PatchSupportThreadDto,
  SupportReplyDto,
} from '../dtos/admin-support.dto';
import { caseMemberSelect } from '../serializers/admin-report-case.serializer';
import { toMemberRef } from '../serializers/admin-member.serializer';
import { toAdminMessages } from '../serializers/admin-message.serializer';
import { staffRefSelect, toStaffRef } from '../serializers/admin-staff.serializer';
import { AdminAppealService } from './admin-appeal.service';
import { AdminAssigneeService } from './admin-assignee.service';
import { AdminEscalationService } from './admin-escalation.service';
import { AdminMemberService } from './admin-member.service';
import { AdminNoteService } from './admin-note.service';

/** How much of the last message the inbox row shows (§5.15). */
const PREVIEW_LENGTH = 140;

/**
 * How long one recorded read covers.
 *
 * The same window as the Guard thread read (§5.12), for the same reason: the portal polls a thread
 * every twenty seconds, and an entry per request is thousands a day per agent per thread — a trail
 * in which every genuine act is buried, which is the same as not having one.
 */
const THREAD_READ_WINDOW_SECONDS = 26 * 3600;

/**
 * What a person can move a thread to by hand (§7.6, §12 Support).
 *
 * Shorter than the state machine, because most transitions are not decisions: a staff reply moves
 * a thread to `WAITING_ON_MEMBER` and a member's reply moves it back, and those happen in
 * `MessageService` where the message is written. What is left here is the judgement calls —
 * picking something up, settling it, and reopening something that was settled too early.
 *
 * `CLOSED` is absent as a target and present as a source: closing is what seven days of silence
 * after a resolution does, and a member writing into a closed thread reopens it.
 */
export const SUPPORT_TRANSITIONS: Record<SupportThreadState, SupportThreadState[]> = {
  [SupportThreadState.NEW]: [SupportThreadState.OPEN, SupportThreadState.RESOLVED],
  [SupportThreadState.OPEN]: [SupportThreadState.WAITING_ON_MEMBER, SupportThreadState.RESOLVED],
  [SupportThreadState.WAITING_ON_MEMBER]: [SupportThreadState.OPEN, SupportThreadState.RESOLVED],
  [SupportThreadState.RESOLVED]: [SupportThreadState.OPEN],
  [SupportThreadState.CLOSED]: [SupportThreadState.OPEN],
};

/** Tidied before they are stored, so one idea is one tag (§5.15). */
export const cleanTags = (tags: string[]): string[] => [
  ...new Set(
    tags
      .map(tag => tag.trim().toLowerCase())
      .filter(Boolean)
      .map(tag => tag.replace(/\s+/g, ' ')),
  ),
];

/** The rows a thread view is built from. */
const threadInclude = {
  member: { select: caseMemberSelect },
  conversation: { select: { contextType: true, contextId: true, contextSnapshot: true } },
} satisfies Prisma.SupportThreadInclude;

type ThreadRow = Prisma.SupportThreadGetPayload<{ include: typeof threadInclude }>;

/**
 * §5.15: the support inbox.
 *
 * Every path in here goes through `threadOrFail`, which is the one place that reads
 * `SupportThread.type` and applies R7. That is not tidiness — it is the only protection a
 * safeguarding disclosure has on this surface. A Guard thread and an ordinary support thread are
 * the same kind of conversation (`ThreadKind.SUPPORT`, `contextType: SUPPORT`, null context id, by
 * D36), so an endpoint that checked `contextType` and trusted its route's `support:read` would
 * hand the support team a member's disclosure in exchange for a uuid. The M0 reply endpoint did
 * exactly that, because the type column it needed did not exist yet.
 */
@Injectable()
export class AdminSupportService {
  private readonly logger = new Logger(AdminSupportService.name);

  constructor(
    private readonly database: PrismaService,
    private readonly policy: AdminPolicyService,
    private readonly media: MediaService,
    private readonly audit: AuditService,
    private readonly config: SystemConfigService,
    private readonly messages: MessageService,
    private readonly conversations: ConversationFactoryService,
    private readonly notes: AdminNoteService,
    private readonly members: AdminMemberService,
    private readonly assignees: AdminAssigneeService,
    private readonly escalations: AdminEscalationService,
    private readonly appeals: AdminAppealService,
  ) {}

  // ─── The inbox ─────────────────────────────────────────────────────────────

  async list(actor: AdminPrincipal, query: ListSupportThreadsDto) {
    query.assertDepth();

    const slaMinutes = await this.config.get(SYSTEM_CONFIG_KEYS.SUPPORT_FIRST_RESPONSE_SLA_MINUTES);
    const now = new Date();
    const where = this.whereFor(actor, query, now, slaMinutes);

    const [total, rows] = await this.database.$transaction([
      this.database.supportThread.count({ where }),
      this.database.supportThread.findMany({
        where,
        include: threadInclude,
        orderBy: this.orderFor(query),
        skip: (query.currentPage - 1) * query.size,
        take: query.size,
      }),
    ]);

    const [staff, previews, counts] = await Promise.all([
      this.staffFor(rows),
      this.previewsFor(rows.map(row => row.conversationId)),
      this.counts(actor),
    ]);

    return {
      data: rows.map(row => this.toRow(row, staff, previews, now, slaMinutes)),
      meta: buildPageMeta({ currentPage: query.currentPage, perPage: query.size }, total, {
        counts,
      }),
    };
  }

  /**
   * The tab counts (§7.6).
   *
   * They ignore the filters on purpose — a count that moved with the filters would be the number
   * of rows on screen, which the page already says. What they do **not** ignore is the caller's
   * visibility: a support agent's `open` count excludes Guard threads, because a number that
   * included them would tell them how many exist.
   */
  private async counts(actor: AdminPrincipal) {
    const visible = this.visibilityWhere(actor);
    const [unassigned, mine, open, waiting] = await this.database.$transaction([
      this.database.supportThread.count({
        where: { ...visible, assignedToId: null, state: { in: OPEN_SUPPORT_STATES } },
      }),
      this.database.supportThread.count({
        where: { ...visible, assignedToId: actor.id, state: { in: OPEN_SUPPORT_STATES } },
      }),
      this.database.supportThread.count({
        where: {
          ...visible,
          state: { in: [SupportThreadState.NEW, SupportThreadState.OPEN] },
        },
      }),
      this.database.supportThread.count({
        where: { ...visible, state: SupportThreadState.WAITING_ON_MEMBER },
      }),
    ]);

    return { unassigned, mine, open, waiting };
  }

  async detail(actor: AdminPrincipal, conversationId: string) {
    const thread = await this.threadOrFail(actor, conversationId, 'read');
    const slaMinutes = await this.config.get(SYSTEM_CONFIG_KEYS.SUPPORT_FIRST_RESPONSE_SLA_MINUTES);
    const now = new Date();

    const [staff, previews, memberSummary, linked, notes] = await Promise.all([
      this.staffFor([thread]),
      this.previewsFor([conversationId]),
      this.members.summary(thread.memberId),
      this.linkedFor(thread),
      this.notes.list(actor, NoteSubjectType.SUPPORT_THREAD, conversationId),
    ]);

    return {
      ...this.toRow(thread, staff, previews, now, slaMinutes),
      memberSummary,
      linked,
      notes,
    };
  }

  /**
   * The thread, in the staff shape (§5.6's `AdminMessage`).
   *
   * `{ messages: [...] }` rather than a bare array, oldest first, with a `role` on each sender —
   * see `toAdminMessages`. This endpoint served the member app's own payload until now, so the
   * portal was sorting by `sentAt` itself and deciding who was Circl by elimination.
   */
  async threadMessages(actor: AdminPrincipal, conversationId: string, query: ListMessagesDto) {
    const thread = await this.threadOrFail(actor, conversationId, 'read');
    const result = await this.messages.pageWithoutAuthorisation(actor.id, conversationId, query);
    const roles = await this.rolesFor(conversationId);

    // §7.6: reading the thread is what marks it read for staff. Conditional so an agent paging
    // back through history does not write on every page.
    if (thread.unreadForStaff) {
      await this.database.supportThread.update({
        where: { conversationId },
        data: { unreadForStaff: 0 },
      });
    }

    // A Guard thread read through the inbox is audited as a **Guard** read, not a support one.
    //
    // Not cosmetic: `guard.thread_read` sits in the SAFETY area and `thread.read` in SUPPORT, and
    // `audit:read_area` is applied in the query — so a disclosure opened through this endpoint
    // would have left its only trace in an area Trust & Safety cannot read. Two doors into one
    // thread, one trail. The key is the Guard one too, so reading it through both doors in a day
    // is one entry rather than two.
    const guard = thread.type === SupportThreadType.GUARD;

    await this.audit.noteOncePer(
      `audit:${guard ? 'guard' : 'support'}-read:${actor.id}:${conversationId}:${new Date()
        .toISOString()
        .slice(0, 10)}`,
      THREAD_READ_WINDOW_SECONDS,
      {
        action: guard ? 'guard.thread_read' : 'thread.read',
        targetType: 'CONVERSATION',
        targetId: conversationId,
        metadata: { messages: result.data?.length ?? 0, type: thread.type },
      },
    );

    return {
      data: { messages: toAdminMessages(result.data ?? [], roles) },
      meta: result.meta,
    };
  }

  /** Who is on the conversation, so a sender can be named as the member or as Circl. */
  private async rolesFor(conversationId: string): Promise<Map<string, ParticipantRole>> {
    const rows = await this.database.conversationParticipant.findMany({
      where: { conversationId },
      select: { userId: true, role: true },
    });

    return new Map(rows.map(row => [row.userId, row.role]));
  }

  // ─── Answering ─────────────────────────────────────────────────────────────

  async reply(actor: AdminPrincipal, conversationId: string, dto: SupportReplyDto) {
    const thread = await this.threadOrFail(actor, conversationId, 'write');
    const canned = dto.cannedReplyId ? await this.cannedFor(dto.cannedReplyId, !dto.body) : null;

    // Replying attaches them to the thread if they are not already on it. Sending requires
    // participation, and reading deliberately does not do this — reading somebody's thread must
    // leave nothing behind in it.
    await this.conversations.addStaff(conversationId, [actor.id]);

    const sent = await this.messages.send(
      actor.id,
      conversationId,
      { ...dto, body: dto.body ?? canned?.body },
      { keepOpen: dto.keepOpen },
    );

    // §7.6: the first reply on an unassigned thread takes it.
    //
    // After the send rather than before, and conditional on it still being unassigned. If this
    // failed the member would still have their answer and the thread would still read as
    // unassigned, which somebody can see and fix; the other order risks a thread that looks
    // handled by somebody who never managed to say anything.
    const claimed = thread.assignedToId
      ? 0
      : (
          await this.database.supportThread.updateMany({
            where: { conversationId, assignedToId: null },
            data: { assignedToId: actor.id, assignedAt: new Date() },
          })
        ).count;

    await this.audit.note({
      // As with the read above: a reply into a disclosure belongs in the Guard trail, whichever
      // endpoint it was sent through.
      action: thread.type === SupportThreadType.GUARD ? 'guard.replied' : 'support.replied',
      targetType: 'CONVERSATION',
      targetId: conversationId,
      // Never the body. The reply is in the thread, which staff can read; a second copy in a table
      // that is deliberately never deleted is a second place a member's answer lives.
      metadata: {
        type: thread.type,
        cannedReplyId: dto.cannedReplyId ?? null,
        keepOpen: Boolean(dto.keepOpen),
        claimed: claimed > 0,
      },
    });

    return sent;
  }

  async assign(actor: AdminPrincipal, conversationId: string, dto: AssignSupportThreadDto) {
    const thread = await this.threadOrFail(actor, conversationId, 'write');
    const assigneeId = dto.assigneeId ?? null;

    if (assigneeId) {
      // B29 / R7: whoever gets a Guard thread has to be able to answer it. `support:manage` is not
      // enough — Trust & Safety hold `guard:manage` and Support do not, and an assignee who cannot
      // reply is a thread that stops reading as unassigned to the people who could.
      await this.assignees.assertHolds(
        assigneeId,
        [thread.type === SupportThreadType.GUARD ? 'guard:manage' : 'support:manage'],
        'assigneeId',
      );

      await this.conversations.addStaff(conversationId, [assigneeId]);
    }

    await this.audit.mutate(
      {
        action: 'support.thread_assigned' as const,
        targetType: 'CONVERSATION' as const,
        targetId: conversationId,
        before: { assignedToId: thread.assignedToId },
        after: { assignedToId: assigneeId },
      },
      tx =>
        tx.supportThread.update({
          where: { conversationId },
          data: { assignedToId: assigneeId, assignedAt: assigneeId ? new Date() : null },
          select: { conversationId: true },
        }),
    );

    this.logger.log(
      `Support thread ${conversationId} assigned to ${assigneeId ?? 'nobody'} by ${actor.id}`,
    );

    return this.row(actor, conversationId);
  }

  async patch(actor: AdminPrincipal, conversationId: string, dto: PatchSupportThreadDto) {
    const thread = await this.threadOrFail(actor, conversationId, 'write');

    if (!dto.state && !dto.tags) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'Send a state, some tags, or both.',
      );
    }

    if (dto.state && !SUPPORT_TRANSITIONS[thread.state].includes(dto.state)) {
      throw ApiException.conflict(
        ApiErrorCode.INVALID_TRANSITION,
        thread.state === dto.state
          ? `That thread is already ${dto.state}.`
          : `A support thread cannot go from ${thread.state} to ${dto.state}.`,
        {
          data: {
            from: thread.state,
            to: dto.state,
            allowed: SUPPORT_TRANSITIONS[thread.state],
          },
        },
      );
    }

    const now = new Date();
    const next = dto.state ?? thread.state;
    const reopening =
      !!dto.state &&
      dto.state === SupportThreadState.OPEN &&
      (thread.state === SupportThreadState.RESOLVED || thread.state === SupportThreadState.CLOSED);

    await this.audit.mutate(
      {
        action: 'support.thread_state_changed' as const,
        targetType: 'CONVERSATION' as const,
        targetId: conversationId,
        before: { state: thread.state, tags: thread.tags },
        after: { state: next, tags: dto.tags ? cleanTags(dto.tags) : thread.tags },
      },
      async tx => {
        // Conditional on the state that was read, like §5.10's escalations: two agents with the
        // same thread open is ordinary, and without this the second write lands on top of the
        // first — a resolution arriving after a reopen would settle a thread that somebody had
        // just reopened on purpose, taking its `reopenCount` with it.
        const { count } = await tx.supportThread.updateMany({
          where: { conversationId, state: thread.state },
          data: {
            ...(dto.state ? { state: dto.state } : {}),
            ...(dto.tags ? { tags: cleanTags(dto.tags) } : {}),
            // One rule for the sort key, wherever the state comes from: recomputed from what the
            // row is about to hold, by the same function the response serialises with.
            waitingSince: waitingSince({
              state: next,
              lastMemberMessageAt: thread.lastMemberMessageAt,
              lastStaffMessageAt: thread.lastStaffMessageAt,
            }),
            ...(dto.state === SupportThreadState.RESOLVED ? { resolvedAt: now } : {}),
            ...(reopening ? { reopenCount: { increment: 1 }, resolvedAt: null } : {}),
          },
        });

        if (!count) {
          throw ApiException.conflict(
            ApiErrorCode.INVALID_TRANSITION,
            'Somebody else moved that thread while this was open. Reload it.',
            { data: { from: thread.state, to: next } },
          );
        }

        return { conversationId };
      },
    );

    return this.row(actor, conversationId);
  }

  // ─── Canned replies ────────────────────────────────────────────────────────

  async cannedReplies(query: ListCannedRepliesDto) {
    const rows = await this.database.cannedReply.findMany({
      where: {
        // Defaults to the active ones: this list is what the reply box offers, and offering a
        // deactivated reply is the one thing deactivating it was meant to stop.
        isActive: query.isActive ?? true,
        ...(query.q
          ? {
              OR: [
                { title: { contains: query.q, mode: 'insensitive' } },
                { body: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ title: 'asc' }],
      take: 200,
    });

    const staff = await this.staffMap(rows.map(row => row.createdById));

    return rows.map(row => this.toCanned(row, staff));
  }

  async createCanned(actor: AdminPrincipal, dto: CreateCannedReplyDto) {
    const { result } = await this.audit.mutate<CannedReply>(
      (created: CannedReply) => ({
        action: 'support.canned_created' as const,
        targetType: 'CANNED_REPLY' as const,
        targetId: created.id,
        after: { title: dto.title, body: dto.body },
      }),
      tx =>
        tx.cannedReply.create({
          data: { title: dto.title, body: dto.body, createdById: actor.id },
        }),
    );

    return this.toCanned(result, await this.staffMap([result.createdById]));
  }

  async patchCanned(actor: AdminPrincipal, id: string, dto: PatchCannedReplyDto) {
    const existing = await this.database.cannedReply.findUnique({ where: { id } });

    if (!existing) throw ApiException.notFound('No such canned reply.');

    if (dto.title === undefined && dto.body === undefined && dto.isActive === undefined) {
      throw ApiException.unprocessable(ApiErrorCode.VALIDATION_FAILED, 'Nothing to change.');
    }

    const { result } = await this.audit.mutate<CannedReply>(
      {
        action: 'support.canned_updated' as const,
        targetType: 'CANNED_REPLY' as const,
        targetId: id,
        before: { title: existing.title, body: existing.body, isActive: existing.isActive },
        after: {
          title: dto.title ?? existing.title,
          body: dto.body ?? existing.body,
          isActive: dto.isActive ?? existing.isActive,
        },
      },
      tx =>
        tx.cannedReply.update({
          where: { id },
          data: {
            ...(dto.title === undefined ? {} : { title: dto.title }),
            ...(dto.body === undefined ? {} : { body: dto.body }),
            ...(dto.isActive === undefined ? {} : { isActive: dto.isActive }),
          },
        }),
    );

    this.logger.log(`Canned reply ${id} updated by ${actor.id}`);

    return this.toCanned(result, await this.staffMap([result.createdById]));
  }

  // ─── Loading and refusing ──────────────────────────────────────────────────

  /**
   * One thread, or the right refusal (R7).
   *
   * The three answers are deliberately different. A conversation that is not a support thread is a
   * `403` naming the access grant, because that is the truth and §5.6's grant is where the caller
   * should go. A Guard thread the caller may not see is a `404`, indistinguishable from an id that
   * does not exist: a `403` would confirm that this member has a safeguarding case, which is most
   * of what the leak would have told them anyway.
   */
  private async threadOrFail(
    actor: AdminPrincipal,
    conversationId: string,
    intent: 'read' | 'write',
  ): Promise<ThreadRow> {
    const thread = await this.database.supportThread.findUnique({
      where: { conversationId },
      include: threadInclude,
    });

    if (!thread) {
      const conversation = await this.database.conversation.findUnique({
        where: { id: conversationId },
        select: { kind: true },
      });

      if (!conversation) throw ApiException.notFound('No such thread.');

      // A support conversation with no staff row should not exist: the factory writes one and the
      // migration backfilled the rest. If one turns up, this is not the caller's problem to be
      // told about in the language of access grants — it is a 404, which fails closed, and a log
      // line, because the inbox cannot show a thread that has no row.
      if (conversation.kind === ThreadKind.SUPPORT) {
        this.logger.warn(`Support conversation ${conversationId} has no SupportThread row`);

        throw ApiException.notFound('No such thread.');
      }

      throw ApiException.forbidden(
        ApiErrorCode.THREAD_ACCESS_REQUIRED,
        'That is a member conversation. Reading it needs an access grant with a reason.',
      );
    }

    this.policy.assertMaySeeSupportThread(actor, thread.type, intent);

    return thread;
  }

  /** One row, re-read after a write so the response is what the database holds. */
  private async row(actor: AdminPrincipal, conversationId: string) {
    const thread = await this.threadOrFail(actor, conversationId, 'read');
    const slaMinutes = await this.config.get(SYSTEM_CONFIG_KEYS.SUPPORT_FIRST_RESPONSE_SLA_MINUTES);
    const [staff, previews] = await Promise.all([
      this.staffFor([thread]),
      this.previewsFor([conversationId]),
    ]);

    return this.toRow(thread, staff, previews, new Date(), slaMinutes);
  }

  private async cannedFor(id: string, needed: boolean) {
    const canned = await this.database.cannedReply.findUnique({ where: { id } });

    if (!canned) throw ApiException.notFound('No such canned reply.');

    // Refused only when the text is coming **from** it. An agent who typed their own body and
    // happened to start from a reply that was retired while they were typing has written their own
    // message, and losing it to a 422 would be the wrong half of the rule.
    if (needed && !canned.isActive) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'That canned reply has been deactivated. Write the message out.',
      );
    }

    return canned;
  }

  // ─── Filters, order and serialisation ──────────────────────────────────────

  /**
   * The Guard half of the `where`, shared by the list and its counts.
   *
   * `type: { in: [] }` where a caller explicitly asks for `GUARD` without `guard:read`: an empty
   * result rather than a refusal, because the filter is theirs to send and the honest answer to
   * "show me Guard threads" from somebody who cannot see any is none of them.
   */
  private visibilityWhere(actor: AdminPrincipal): Prisma.SupportThreadWhereInput {
    return this.policy.maySeeGuardThreads(actor) ? {} : { type: { not: SupportThreadType.GUARD } };
  }

  /**
   * The same predicate the inbox uses, for §5.26's export.
   *
   * Public rather than copied, because R7 is its first clause: a Guard thread is excluded for
   * anybody without `guard:read`, and an export built from a second implementation would be a way
   * around that — on the one path where the rows leave the portal as a file.
   */
  async exportWhere(
    actor: AdminPrincipal,
    query: ListSupportThreadsDto,
  ): Promise<Prisma.SupportThreadWhereInput> {
    const slaMinutes = await this.config.get(SYSTEM_CONFIG_KEYS.SUPPORT_FIRST_RESPONSE_SLA_MINUTES);

    return this.whereFor(actor, query, new Date(), slaMinutes);
  }

  private whereFor(
    actor: AdminPrincipal,
    query: ListSupportThreadsDto,
    now: Date,
    slaMinutes: number,
  ): Prisma.SupportThreadWhereInput {
    const visible = this.policy.maySeeGuardThreads(actor);
    const asked = query.type?.length
      ? query.type.filter(type => visible || type !== SupportThreadType.GUARD)
      : null;
    const and: Prisma.SupportThreadWhereInput[] = [];

    if (query.overdue) {
      and.push({
        firstResponseAt: null,
        firstMemberMessageAt: { lt: new Date(now.getTime() - slaMinutes * 60_000) },
        // A settled thread stopped the clock. Without this a thread resolved by the member going
        // quiet reads as overdue for ever, and the overdue tab fills with work nobody can do.
        state: { in: OPEN_SUPPORT_STATES },
      });
    }

    if (query.q) {
      and.push({
        OR: [
          { member: { firstName: { contains: query.q, mode: 'insensitive' } } },
          { member: { lastName: { contains: query.q, mode: 'insensitive' } } },
          { member: { email: { contains: query.q, mode: 'insensitive' } } },
          { member: { username: { contains: query.q, mode: 'insensitive' } } },
          // The subject as the member's own inbox shows it, which lives in the conversation's
          // display snapshot rather than a column of its own.
          {
            conversation: {
              contextSnapshot: { path: ['title'], string_contains: query.q },
            },
          },
        ],
      });
    }

    return {
      state: { in: query.state?.length ? query.state : OPEN_SUPPORT_STATES },
      ...(asked ? { type: { in: asked } } : this.visibilityWhere(actor)),
      ...(query.view === 'unassigned' ? { assignedToId: null } : {}),
      ...(query.view === 'mine' ? { assignedToId: actor.id } : {}),
      ...(query.assignedToId ? { assignedToId: query.assignedToId } : {}),
      ...(query.memberId ? { memberId: query.memberId } : {}),
      ...(and.length ? { AND: and } : {}),
    };
  }

  /**
   * The order, with the nulls where they belong.
   *
   * `waitingSince` defaults to ascending where the caller did not say, because the only reason to
   * sort by a wait is to answer the longest one first — and nulls sort last in both directions,
   * since a thread nobody is waiting on has no wait to place. The id is the tiebreaker so a page
   * boundary cannot repeat or skip a row between two threads with the same timestamp.
   */
  private orderFor(query: ListSupportThreadsDto): Prisma.SupportThreadOrderByWithRelationInput[] {
    const order = query.order ?? (query.sort === 'waitingSince' ? 'asc' : 'desc');

    switch (query.sort) {
      case 'createdAt':
        return [{ createdAt: order }, { conversationId: 'asc' }];
      case 'waitingSince':
        return [{ waitingSince: { sort: order, nulls: 'last' } }, { conversationId: 'asc' }];
      default:
        return [{ lastMemberMessageAt: { sort: order, nulls: 'last' } }, { conversationId: 'asc' }];
    }
  }

  private async staffFor(rows: Array<{ assignedToId: string | null }>) {
    return this.staffMap(rows.map(row => row.assignedToId).filter(Boolean) as string[]);
  }

  private async staffMap(ids: string[]) {
    const unique = [...new Set(ids.filter(Boolean))];

    if (!unique.length) return new Map<string, Parameters<typeof toStaffRef>[0]>();

    const rows = await this.database.user.findMany({
      where: { id: { in: unique } },
      select: staffRefSelect,
    });

    return new Map(rows.map(person => [person.id, person]));
  }

  /** The last thing said in each thread, for the row preview. */
  private async previewsFor(conversationIds: string[]) {
    const map = new Map<string, string | null>();

    if (!conversationIds.length) return map;

    const rows = await this.database.message.findMany({
      where: { conversationId: { in: conversationIds }, deletedAt: null },
      // One row per conversation, newest first.
      orderBy: [{ conversationId: 'asc' }, { sentAt: 'desc' }],
      distinct: ['conversationId'],
      select: { conversationId: true, body: true },
    });

    for (const row of rows) {
      map.set(
        row.conversationId,
        row.body ? row.body.slice(0, PREVIEW_LENGTH).trim() || null : null,
      );
    }

    return map;
  }

  /**
   * What else is attached to this thread (§5.15).
   *
   * Looked up by `conversationId` rather than read off the conversation's context, because a
   * support thread's context is `SUPPORT` with a null id for three of the five types (D36) — the
   * context cannot say which deal or dispute it is about. The records themselves carry the link.
   *
   * `guardCaseId` is safe to publish here even though it names a safeguarding case: a conversation
   * with a `GuardThread` on it is a thread `settledType` has already raised to `GUARD`, so getting
   * this far means the caller holds `guard:read`.
   */
  private async linkedFor(thread: ThreadRow) {
    const conversationId = thread.conversationId;
    const [managed, dispute, guard, dealFlag, escalations, appeals] = await Promise.all([
      this.database.managedRequest.findFirst({
        where: { conversationId },
        select: { id: true, briefId: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.database.dispute.findFirst({
        where: { conversationId },
        select: { id: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.database.guardThread.findFirst({
        where: { conversationId },
        select: { id: true },
        orderBy: { createdAt: 'desc' },
      }),
      // A deal problem reuses the member's own support conversation, so the thread cannot name the
      // deal — the system message announcing the problem is where the link actually lives, and the
      // latest one is the problem the agent is being asked about.
      this.database.message.findFirst({
        where: { conversationId, systemType: SystemMessageType.DEAL_PROBLEM_FLAGGED },
        select: { systemData: true },
        orderBy: { sentAt: 'desc' },
      }),
      this.escalations.forConversation(conversationId),
      this.appeals.forConversation(conversationId),
    ]);

    const dealId = (dealFlag?.systemData as { dealId?: string } | null)?.dealId ?? null;
    const contextId = thread.conversation?.contextId ?? null;

    return {
      managedRequestId: managed?.id ?? null,
      briefId:
        managed?.briefId ??
        (thread.conversation?.contextType === ThreadContextType.BRIEF ? contextId : null),
      disputeId: dispute?.id ?? null,
      dealId,
      guardCaseId: guard?.id ?? null,
      escalations,
      appeals,
    };
  }

  private toRow(
    thread: ThreadRow,
    staff: Map<string, Parameters<typeof toStaffRef>[0]>,
    previews: Map<string, string | null>,
    now: Date,
    slaMinutes: number,
  ) {
    const snapshot = thread.conversation?.contextSnapshot as { title?: string } | null;
    const person = thread.assignedToId ? staff.get(thread.assignedToId) : null;
    // Recomputed rather than read from the column. The column is the sort key and can only be as
    // fresh as the last write; this is the answer, and it is derived from the timestamps every
    // time, so the two can disagree about the order of a page and never about the facts on it.
    const waiting = waitingSince(thread);

    return {
      conversationId: thread.conversationId,
      type: thread.type,
      state: thread.state,
      member: toMemberRef(thread.member, this.media.sign),
      subject: snapshot?.title ?? 'Circl team',
      context: {
        type: thread.conversation?.contextType ?? null,
        id: thread.conversation?.contextId ?? null,
      },
      assignedTo: person ? toStaffRef(person, this.media.sign) : null,
      lastMessagePreview: previews.get(thread.conversationId) ?? null,
      lastMemberMessageAt: thread.lastMemberMessageAt?.toISOString() ?? null,
      lastStaffMessageAt: thread.lastStaffMessageAt?.toISOString() ?? null,
      firstResponseAt: thread.firstResponseAt?.toISOString() ?? null,
      waitingSince: waiting?.toISOString() ?? null,
      overdue: this.isOverdue(thread, now, slaMinutes),
      unreadForStaff: thread.unreadForStaff,
      reopenCount: thread.reopenCount,
      tags: thread.tags,
      assignedAt: thread.assignedAt?.toISOString() ?? null,
      resolvedAt: thread.resolvedAt?.toISOString() ?? null,
      createdAt: thread.createdAt.toISOString(),
    };
  }

  /** The same predicate as the `overdue` filter, so the flag and the tab cannot disagree. */
  private isOverdue(thread: ThreadRow, now: Date, slaMinutes: number): boolean {
    if (thread.firstResponseAt || !thread.firstMemberMessageAt) return false;
    if (!OPEN_SUPPORT_STATES.includes(thread.state)) return false;

    return now.getTime() - thread.firstMemberMessageAt.getTime() > slaMinutes * 60_000;
  }

  private toCanned(
    row: {
      id: string;
      title: string;
      body: string;
      isActive: boolean;
      createdById: string;
      updatedAt: Date;
    },
    staff: Map<string, Parameters<typeof toStaffRef>[0]>,
  ) {
    const person = staff.get(row.createdById);

    return {
      id: row.id,
      title: row.title,
      body: row.body,
      isActive: row.isActive,
      createdBy: person ? toStaffRef(person, this.media.sign) : null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
