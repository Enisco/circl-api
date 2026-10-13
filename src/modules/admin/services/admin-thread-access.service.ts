import { Injectable } from '@nestjs/common';
import {
  ParticipantRole,
  ReportTargetType,
  ThreadAccessLinkType,
  ThreadKind,
} from '@prisma/client';
import { ApiErrorCode, ApiException } from '@/common';
import { PrismaService } from '@/infrastructure';
import { ListMessagesDto, MessageService } from '@/modules/platform/messaging';
import { MediaService } from '@/modules/platform/shared';
import { AuditService } from '../audit/audit.service';
import { AdminPolicyService } from '../common/admin-policy.service';
import { AdminPrincipal } from '../common/admin-principal';
import { adminContext } from '../common/admin-context';
import { GrantThreadAccessDto } from '../dtos/admin-thread-access.dto';
import { AdminMessageView, toAdminMessages } from '../serializers/admin-message.serializer';
import { MemberRefView, toMemberRef } from '../serializers/admin-member.serializer';
import { caseMemberSelect } from '../serializers/admin-report-case.serializer';

/** S9.2: thirty minutes, for that staff member and that conversation only. */
const GRANT_MINUTES = 30;

/** A grant id is a uuid. Anything else is not a grant, and is refused as one rather than as a 400. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the thread is, and what it is about (§5.6's `ThreadHeader`). */
export interface ThreadHeaderView {
  conversationId: string;
  kind: ThreadKind;
  /** What the thread hangs off — a booking, an enquiry, a listing — as the member's app shows it. */
  context: { type: string | null; id: string | null; snapshot: unknown } | null;
  participants: Array<
    MemberRefView & { role: ParticipantRole; joinedAt: string; leftAt: string | null }
  >;
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
  /**
   * The reports filed about this conversation or about a message in it.
   *
   * On the header rather than left to the reviewer to go and look for, because "has anybody
   * complained about this thread before" is the first question somebody reading one asks, and the
   * answer is two joins away from a screen that already has the conversation id.
   */
  reports: Array<{
    id: string;
    caseId: string | null;
    reasonCode: string;
    targetType: string;
    targetId: string;
    createdAt: string;
  }>;
  /** The grant this was read under, so the portal's banner can count down to its expiry. */
  grant: {
    id: string;
    reasonCode: string;
    linkedType: ThreadAccessLinkType;
    linkedId: string;
    grantedAt: string;
    expiresAt: string;
  };
}

/**
 * §5.6 / §3.9: reading two members' private conversation.
 *
 * This is the most invasive read in the portal and it is built to feel like it. Everywhere else, a
 * permission is a property of the person — `messages:read` is enough to list which conversations a
 * member has. It is deliberately **not** enough to read the words in one. That needs a grant: a
 * row naming the staff member, the conversation, a reason code and a record that can be opened by
 * whoever asks about it later, valid for thirty minutes and for nothing else.
 *
 * The alternative was a permission, and a permission is the wrong shape for this. There is no
 * honest answer to "who may read members' private messages", because the question is not about the
 * person — anybody who needs to read one needs to read it *for a reason*. A reason is checkable;
 * a job title is not. So the grant is the audit entry written before the act rather than after it,
 * which is also what makes it a 403 rather than a policy breach somebody discovers in a quarterly
 * review.
 *
 * Three refusals matter:
 *
 *  - **Free text is never a reason.** `linkedType` + `linkedId` only. "Investigating a complaint"
 *    cannot be checked by anybody; report case `7f3a` can be opened.
 *  - **The link has to be real** — it must exist, the caller must already be able to see it under
 *    their own permissions, and it must involve somebody in the conversation. Otherwise the link is
 *    a formality: any case id would do, and the trail would record a reason that had nothing to do
 *    with the thread.
 *  - **Support and Guard threads are not read here.** They have their own endpoints with their own
 *    permissions (§5.15, §5.12), and a conversation whose `kind` is `SUPPORT` answers 409 with the
 *    endpoint that does serve it. Reading a safeguarding disclosure through a grant would route
 *    around R7 entirely — `messages:read` is far more widely held than `guard:read`.
 *
 * S9.4 is the quiet one: reading must not change anything the member can see. No participant row,
 * no read receipt, no unread count, no presence. `MessageService.pageWithoutAuthorisation` is
 * written for exactly this and does none of them.
 */
@Injectable()
export class AdminThreadAccessService {
  constructor(
    private readonly database: PrismaService,
    private readonly messaging: MessageService,
    private readonly media: MediaService,
    private readonly audit: AuditService,
    private readonly policy: AdminPolicyService,
  ) {}

  // ─── The grant ─────────────────────────────────────────────────────────────

  /** S9.1: checks the thread may be read this way, checks the link, and records the grant. */
  async grant(actor: AdminPrincipal, conversationId: string, dto: GrantThreadAccessDto) {
    const conversation = await this.readableConversation(conversationId);
    const participantIds = await this.participantIds(conversationId);

    await this.assertLink(actor, dto, participantIds, conversationId);

    const context = adminContext.current();
    const expiresAt = new Date(Date.now() + GRANT_MINUTES * 60_000);

    // The grant row and its audit entry in one transaction (S11.1). A grant written without a
    // trail is the thing this whole mechanism exists to prevent, and the reverse — an entry
    // naming a grant that was never issued — would be a trail nobody can trust either.
    const { result } = await this.audit.mutate(
      (grantRow: { id: string; expiresAt: Date }) => ({
        action: 'thread.access_granted' as const,
        targetType: 'CONVERSATION' as const,
        targetId: conversationId,
        metadata: {
          grantId: grantRow.id,
          reasonCode: dto.reasonCode,
          linkedType: dto.linkedType,
          linkedId: dto.linkedId,
          expiresAt: grantRow.expiresAt.toISOString(),
          kind: conversation.kind,
          participants: participantIds.length,
        },
      }),
      tx =>
        tx.threadAccessGrant.create({
          data: {
            staffId: actor.id,
            conversationId,
            reasonCode: dto.reasonCode,
            linkedType: dto.linkedType,
            linkedId: dto.linkedId,
            note: dto.note ?? null,
            ip: context?.clientIp ?? null,
            userAgent: context?.userAgent ?? null,
            expiresAt,
          },
        }),
    );

    return {
      grantId: result.id,
      expiresAt: result.expiresAt.toISOString(),
      // Returned rather than left for the portal to recompute from two timestamps, because the
      // banner it drives is the one thing telling a staff member they are inside a recorded read.
      expiresInSeconds: GRANT_MINUTES * 60,
    };
  }

  // ─── The reads ─────────────────────────────────────────────────────────────

  /** The header on its own, for the screen that opens before the first page of messages lands. */
  async header(actor: AdminPrincipal, conversationId: string, grantId: string) {
    const grant = await this.liveGrant(actor, conversationId, grantId);
    const header = await this.buildHeader(conversationId, grant);

    await this.recordRead(actor, conversationId, grant, []);

    return header;
  }

  /**
   * One page of messages, newest first, with the header beside it.
   *
   * Cursor paging rather than pages, as §5.6 specifies: a thread is read newest-first and grows
   * while it is open, so an offset into it means something different by the time it is used.
   */
  async messages(
    actor: AdminPrincipal,
    conversationId: string,
    grantId: string,
    query: ListMessagesDto,
  ) {
    const grant = await this.liveGrant(actor, conversationId, grantId);
    const [header, page] = await Promise.all([
      this.buildHeader(conversationId, grant),
      this.messaging.pageWithoutAuthorisation(actor.id, conversationId, query),
    ]);

    const roles = await this.rolesFor(conversationId);
    const reported = await this.reportedMessageIds((page.data ?? []).map(message => message.id));
    const messages = toAdminMessages(page.data ?? [], roles, reported);

    await this.recordRead(actor, conversationId, grant, messages);

    return {
      data: {
        header,
        messages,
        // S9.5: the portal keeps its banner up for as long as this is true, which is always. It is
        // a statement to the person reading, not a flag the API negotiates.
        accessLogged: true as const,
        expiresAt: grant.expiresAt.toISOString(),
      },
      meta: {
        // §5.6 names it `nextBefore`: the cursor to send back as `before`. The member app's
        // messaging meta calls the same value `nextCursor`, and renaming it here is deliberate —
        // this endpoint takes `before` and nothing else, so a cursor called `nextCursor` invites
        // somebody to try it on `after`.
        nextBefore: page.meta?.nextCursor ?? null,
        hasMore: Boolean(page.meta?.nextCursor),
      },
    };
  }

  // ─── Checks ────────────────────────────────────────────────────────────────

  /**
   * The conversation, if it is one this endpoint serves at all.
   *
   * A support or Guard thread is a 409 naming the endpoint that does serve it, rather than a 404
   * or a grant that works: both of those would be ways around R7. §5.12 and §5.15 gate on
   * `guard:read` and `support:read`, and this endpoint gates on `messages:read`, which far more
   * people hold.
   */
  private async readableConversation(conversationId: string) {
    const conversation = await this.database.conversation.findUnique({
      where: { id: conversationId },
      select: {
        id: true,
        kind: true,
        contextType: true,
        contextId: true,
        contextSnapshot: true,
        messageCount: true,
        lastMessageAt: true,
        createdAt: true,
        guardThread: { select: { id: true } },
        supportThread: { select: { conversationId: true } },
      },
    });

    if (!conversation) throw ApiException.notFound('No such conversation.');

    if (conversation.kind === ThreadKind.SUPPORT || conversation.guardThread) {
      const redirect = conversation.guardThread
        ? `/admin/guard/cases/${conversation.guardThread.id}/messages`
        : `/admin/support/threads/${conversationId}/messages`;

      throw ApiException.conflict(
        ApiErrorCode.USE_SUPPORT_INBOX,
        conversation.guardThread
          ? 'That is a Guard case. Read it through the Guard case, which needs `guard:read`.'
          : 'That is a support thread. Read it through the support inbox.',
        { data: { redirect } },
      );
    }

    return conversation;
  }

  /**
   * S9.1's three conditions on the link, in the order they are cheapest to check.
   *
   * The permission check comes before the existence check on purpose: "you cannot see disputes"
   * and "that dispute does not exist" are different answers, and answering the second to somebody
   * who is not allowed the first tells them a dispute id is real.
   */
  private async assertLink(
    actor: AdminPrincipal,
    dto: GrantThreadAccessDto,
    participantIds: string[],
    conversationId: string,
  ): Promise<void> {
    const refuse = (message: string) =>
      ApiException.unprocessable(ApiErrorCode.LINK_REQUIRED, message, {
        details: [{ field: 'linkedId', message }],
        data: { linkedType: dto.linkedType, linkedId: dto.linkedId },
      });

    const needs = (permission: string) => {
      if (!actor.permissions.has(permission)) {
        throw refuse(
          `Reading a thread for a ${label(dto.linkedType)} needs \`${permission}\`, which you do not hold.`,
        );
      }
    };

    const members = await this.linkedMembers(actor, dto, needs);

    if (!members) throw refuse(`No such ${label(dto.linkedType)}.`);

    // A case filed about this conversation, or about a message in it, is about the thread itself —
    // which is the §6.8 case: a flagged message raises a queue item whose subject is the sender,
    // but a *member* reporting a message files a case whose target is the message and whose
    // `targetUserId` may be nobody if the sender's account has since gone.
    if (await this.linkedToThisThread(dto, conversationId)) return;

    // Otherwise the link has to be about somebody in the conversation. Without this, any case id
    // the caller can see would open any thread on the platform — the link would be a formality and
    // the trail would record a reason unconnected to what was read.
    if (!members.some(id => participantIds.includes(id))) {
      throw refuse(
        `That ${label(dto.linkedType)} does not involve anybody in this conversation, so it is not a reason to read it.`,
      );
    }
  }

  /**
   * Whether the linked record is about **this** conversation rather than about a person.
   *
   * A report or a queue item whose target is the conversation, or a message inside it, is as
   * direct a reason as there is — and the participant test can miss it: a message report's
   * `targetUserId` is the sender, who may have left the thread or had their account removed.
   */
  private async linkedToThisThread(
    dto: GrantThreadAccessDto,
    conversationId: string,
  ): Promise<boolean> {
    const target = await this.targetOf(dto);

    if (!target) return false;

    if (target.targetType === ReportTargetType.CONVERSATION) {
      return target.targetId === conversationId;
    }

    if (target.targetType !== ReportTargetType.MESSAGE) return false;

    const message = await this.database.message.findUnique({
      where: { id: target.targetId },
      select: { conversationId: true },
    });

    return message?.conversationId === conversationId;
  }

  /** What the linked record points at, for the kinds that point at content. */
  private async targetOf(
    dto: GrantThreadAccessDto,
  ): Promise<{ targetType: ReportTargetType; targetId: string } | null> {
    if (dto.linkedType === ThreadAccessLinkType.REPORT_CASE) {
      return this.database.reportCase.findUnique({
        where: { id: dto.linkedId },
        select: { targetType: true, targetId: true },
      });
    }

    if (dto.linkedType === ThreadAccessLinkType.QUEUE_ITEM) {
      return this.database.moderationQueueItem.findUnique({
        where: { id: dto.linkedId },
        select: { targetType: true, targetId: true },
      });
    }

    return null;
  }

  /** The members a linked record is about, or null when there is no such record. */
  private async linkedMembers(
    actor: AdminPrincipal,
    dto: GrantThreadAccessDto,
    needs: (permission: string) => void,
  ): Promise<string[] | null> {
    const id = dto.linkedId;

    switch (dto.linkedType) {
      case ThreadAccessLinkType.REPORT_CASE: {
        needs('reports:read');

        const row = await this.database.reportCase.findUnique({
          where: { id },
          select: { targetUserId: true, targetType: true, targetId: true },
        });

        if (!row) return null;

        /**
         * The case's **subject**, not its reporters.
         *
         * Counting the reporters looked more generous and was the hole: a member who has ever
         * reported anybody would then have a case id that opens any conversation they are in,
         * including ones with nothing to do with what they complained about. The reason has to be
         * about somebody in the thread, and "they filed this" is not that.
         *
         * A case about a member names them in `targetId` when the target type is `USER`, and in
         * `targetUserId` when it is their content — so both are read.
         */
        return [
          row.targetUserId,
          row.targetType === ReportTargetType.USER ? row.targetId : null,
        ].filter((value): value is string => !!value);
      }

      case ThreadAccessLinkType.ESCALATION: {
        needs('reports:read');

        const row = await this.database.escalation.findUnique({
          where: { id },
          select: { memberId: true },
        });

        return row ? [row.memberId] : null;
      }

      case ThreadAccessLinkType.GUARD_CASE: {
        needs('guard:read');

        const row = await this.database.guardThread.findUnique({
          where: { id },
          select: { userId: true },
        });

        return row ? [row.userId] : null;
      }

      case ThreadAccessLinkType.QUEUE_ITEM: {
        needs('moderation:read');

        const row = await this.database.moderationQueueItem.findUnique({
          where: { id },
          select: { subjectUserId: true, targetType: true, targetId: true },
        });

        if (!row) return null;

        // A `USER` target names the member in `targetId`; everything else names them in
        // `subjectUserId`, which is who the item is about rather than what it is about.
        return [
          row.subjectUserId,
          row.targetType === ReportTargetType.USER ? row.targetId : null,
        ].filter((value): value is string => !!value);
      }

      case ThreadAccessLinkType.DISPUTE: {
        needs('disputes:manage');

        const row = await this.database.dispute.findUnique({
          where: { id },
          select: {
            raisedById: true,
            booking: { select: { clientId: true, professionalId: true } },
            enquiry: { select: { buyerId: true, sellerId: true } },
          },
        });

        if (!row) return null;

        // Both sides, from whichever subject the dispute hangs off: a dispute read as "the person
        // who complained" alone would not open the thread between the two of them when the other
        // party is the one who owns it.
        return [
          row.raisedById,
          row.booking?.clientId,
          row.booking?.professionalId,
          row.enquiry?.buyerId,
          row.enquiry?.sellerId,
        ].filter((value): value is string => !!value);
      }

      case ThreadAccessLinkType.SUPPORT_THREAD: {
        const row = await this.database.supportThread.findUnique({
          where: { conversationId: id },
          select: { memberId: true, type: true },
        });

        if (!row) return null;

        // R7 rather than a bare `support:read`: a Guard thread is a support thread with a different
        // type, and using one as the reason for reading a member's private messages must need the
        // permission that reads the disclosure itself.
        this.policy.assertMaySeeSupportThread(actor, row.type, 'read');

        return [row.memberId];
      }
    }
  }

  /**
   * S9.2: a live grant for this staff member and this conversation.
   *
   * Every failure is the same 403 with the same message. Telling the caller whether a grant id
   * exists, has expired or belongs to a colleague would make a grant id something to probe for,
   * and all three have the same remedy: ask for a grant.
   */
  private async liveGrant(actor: AdminPrincipal, conversationId: string, grantId: string) {
    // Checked before the query, and this is not a formality: `findFirst` ignores an `undefined`
    // field rather than matching nothing, so a request with **no** header would have been answered
    // by whatever other live grant that staff member happened to hold for this conversation. A
    // missing credential must never be a wildcard.
    const grant = UUID.test(grantId ?? '')
      ? await this.database.threadAccessGrant.findFirst({
          where: { id: grantId, staffId: actor.id, conversationId, expiresAt: { gt: new Date() } },
        })
      : null;

    if (!grant) {
      throw ApiException.forbidden(
        ApiErrorCode.THREAD_ACCESS_REQUIRED,
        'Reading this thread needs a live access grant. Ask for one, naming the case you are working on.',
        { data: { conversationId } },
      );
    }

    // The conversation is re-checked on every read, not only when the grant was issued: a thread
    // that has since become a support or Guard thread must stop being readable this way, and the
    // grant outlives the check that created it by half an hour.
    await this.readableConversation(conversationId);

    return grant;
  }

  // ─── Building the answer ───────────────────────────────────────────────────

  private async buildHeader(
    conversationId: string,
    grant: {
      id: string;
      reasonCode: string;
      linkedType: ThreadAccessLinkType;
      linkedId: string;
      grantedAt: Date;
      expiresAt: Date;
    },
  ): Promise<ThreadHeaderView> {
    const [conversation, participants, reports] = await Promise.all([
      this.database.conversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: {
          kind: true,
          contextType: true,
          contextId: true,
          contextSnapshot: true,
          messageCount: true,
          lastMessageAt: true,
          createdAt: true,
        },
      }),
      this.database.conversationParticipant.findMany({
        where: { conversationId },
        select: {
          role: true,
          joinedAt: true,
          leftAt: true,
          user: { select: caseMemberSelect },
        },
        orderBy: { joinedAt: 'asc' },
      }),
      this.reportsAbout(conversationId),
    ]);

    return {
      conversationId,
      kind: conversation.kind,
      context: conversation.contextType
        ? {
            type: conversation.contextType,
            id: conversation.contextId,
            snapshot: conversation.contextSnapshot ?? null,
          }
        : null,
      participants: participants.map(row => ({
        ...toMemberRef(row.user, this.media.sign),
        role: row.role,
        joinedAt: row.joinedAt.toISOString(),
        leftAt: row.leftAt?.toISOString() ?? null,
      })),
      messageCount: conversation.messageCount,
      lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
      createdAt: conversation.createdAt.toISOString(),
      reports,
      grant: {
        id: grant.id,
        reasonCode: grant.reasonCode,
        linkedType: grant.linkedType,
        linkedId: grant.linkedId,
        grantedAt: grant.grantedAt.toISOString(),
        expiresAt: grant.expiresAt.toISOString(),
      },
    };
  }

  /**
   * Reports about the conversation itself, and about any message in it.
   *
   * A join rather than two queries, and that is a fix rather than a flourish: the first version
   * read the conversation's message ids and passed them as an `IN` list, which meant a thread
   * longer than the `take` silently stopped reporting complaints about its older messages — on
   * the screen whose whole job is to say whether anybody has complained before. `Report` holds no
   * foreign key to `Message` (the target is polymorphic), so the join is raw.
   */
  private async reportsAbout(conversationId: string) {
    const rows = await this.database.$queryRaw<
      Array<{
        id: string;
        case_id: string | null;
        reason_code: string;
        target_type: string;
        target_id: string;
        created_at: Date;
      }>
    >`
      SELECT r."id", r."case_id", r."reason_code"::text, r."target_type"::text, r."target_id",
             r."created_at"
      FROM "reports" r
      WHERE (r."target_type" = 'CONVERSATION' AND r."target_id" = ${conversationId})
         OR (r."target_type" = 'MESSAGE'
             AND EXISTS (
               SELECT 1 FROM "messages" m
               WHERE m."id" = r."target_id" AND m."conversation_id" = ${conversationId}
             ))
      ORDER BY r."created_at" DESC
      LIMIT 50
    `;

    // No reporter, on purpose. R9 keys a reporter's identity on `moderation:read` and this endpoint
    // gates on `messages:read` — and of all the screens to leak who complained about somebody, the
    // one showing their private messages to the person investigating them is the worst.
    return rows.map(row => ({
      id: row.id,
      caseId: row.case_id,
      reasonCode: row.reason_code,
      targetType: row.target_type,
      targetId: row.target_id,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  private async rolesFor(conversationId: string): Promise<Map<string, ParticipantRole>> {
    const rows = await this.database.conversationParticipant.findMany({
      where: { conversationId },
      select: { userId: true, role: true },
    });

    return new Map(rows.map(row => [row.userId, row.role]));
  }

  /** Which of these messages somebody has reported, so the reviewer can see which one it was about. */
  private async reportedMessageIds(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();

    const rows = await this.database.report.findMany({
      where: { targetType: 'MESSAGE', targetId: { in: ids } },
      select: { targetId: true },
    });

    return new Set(rows.map(row => row.targetId));
  }

  private async participantIds(conversationId: string): Promise<string[]> {
    const rows = await this.database.conversationParticipant.findMany({
      where: { conversationId },
      select: { userId: true },
    });

    return rows.map(row => row.userId);
  }

  /**
   * S9.3: one `thread.read` entry per page fetched, with the message id range.
   *
   * Not deduplicated, unlike the Guard and support reads, which record once per staff member per
   * thread per day. Those are inboxes somebody works in all afternoon and the portal polls every
   * thirty seconds; this is a thirty-minute window somebody had to ask for by naming a case, and
   * how far back through two members' conversation they actually read is the substance of what
   * happened. A day-level entry would say "they opened it" and nothing about how much they read.
   *
   * The grant's own counters move with it, so a grant taken and never used stays visibly unused.
   */
  private async recordRead(
    actor: AdminPrincipal,
    conversationId: string,
    grant: { id: string; linkedType: ThreadAccessLinkType; linkedId: string },
    messages: AdminMessageView[],
  ): Promise<void> {
    await this.database.threadAccessGrant.update({
      where: { id: grant.id },
      data: { lastUsedAt: new Date(), useCount: { increment: 1 } },
    });

    await this.audit.note({
      action: 'thread.read',
      targetType: 'CONVERSATION',
      targetId: conversationId,
      metadata: {
        grantId: grant.id,
        linkedType: grant.linkedType,
        linkedId: grant.linkedId,
        messages: messages.length,
        // The range, as §5.6 asks: which part of the conversation this page was. Ids rather than
        // timestamps, because a message id is what the next page's cursor is and the two entries
        // can be lined up.
        firstMessageId: messages[0]?.id ?? null,
        lastMessageId: messages[messages.length - 1]?.id ?? null,
      },
    });
  }
}

/** The record type, in the words a refusal should use. */
const label = (type: ThreadAccessLinkType): string =>
  ({
    REPORT_CASE: 'report case',
    SUPPORT_THREAD: 'support thread',
    GUARD_CASE: 'Guard case',
    DISPUTE: 'dispute',
    ESCALATION: 'escalation',
    QUEUE_ITEM: 'queue item',
  })[type];
