import { Injectable } from '@nestjs/common';
import { Conversation, MessageKind, Prisma, ThreadContextType, ThreadKind } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException, buildPageMeta } from '@/common';
import {
  AuthorView,
  BlockingService,
  MediaService,
  authorSelect,
  toAuthorView,
} from '../../shared';
import { ListConversationsDto, StartThreadDto } from '../dtos/message.dto';
import { ConversationFactoryService } from './conversation-factory.service';

export interface ContextView {
  type: ThreadContextType | null;
  id: string | null;
  title: string;
  subtitle: string | null;
  thumbnailUrl: string | null;
  trailing: string | null;
  /** Sent from the server, so a new context type is tappable without a release. */
  route: string | null;
}

/** The chip on an inbox row. */
export type ThreadLabel =
  | 'OFFERED_HELP'
  | 'ABOUT_REQUEST'
  | 'ABOUT_LISTING'
  | 'ABOUT_CONNECTION'
  | 'ABOUT_ORDER'
  | 'CIRCL_TEAM'
  | null;

const conversationInclude = {
  participants: {
    include: {
      user: {
        select: {
          ...authorSelect,
          // Presence is not persisted; lastActiveAt on the session is the closest honest signal, and it is read here rather than invented.
          sessions: {
            where: { isActive: true },
            orderBy: { lastActiveAt: 'desc' },
            take: 1,
            select: { lastActiveAt: true },
          },
        },
      },
    },
  },
} satisfies Prisma.ConversationInclude;

type ConversationRow = Prisma.ConversationGetPayload<{ include: typeof conversationInclude }>;

@Injectable()
export class ConversationService {
  constructor(
    private readonly database: PrismaService,
    private readonly blocking: BlockingService,
    private readonly factory: ConversationFactoryService,
    private readonly media: MediaService,
  ) {}

  // ─── 5.3.1 The inbox ───────────────────────────────────────────────────────

  async list(userId: string, query: ListConversationsDto) {
    const blockedIds = await this.blocking.blockedUserIds(userId);

    const where: Prisma.ConversationWhereInput = {
      participants: {
        some: {
          userId,
          ...(query.includeArchived ? {} : { isArchived: false }),
          ...(query.unreadOnly ? { unreadCount: { gt: 0 } } : {}),
        },
      },
      ...(query.kind ? { kind: query.kind } : {}),
      // A blocked pair's threads are hidden from the inbox entirely (5.7).
      ...(blockedIds.length
        ? { NOT: { participants: { some: { userId: { in: blockedIds } } } } }
        : {}),
    };

    if (query.q) {
      // D31: names and CONTEXT TITLES at launch — both short, so both stay fast.
      where.AND = [
        {
          OR: [
            {
              participants: {
                some: { user: { firstName: { contains: query.q, mode: 'insensitive' } } },
              },
            },
            {
              participants: {
                some: { user: { lastName: { contains: query.q, mode: 'insensitive' } } },
              },
            },
            {
              contextSnapshot: {
                path: ['title'],
                string_contains: query.q,
                mode: 'insensitive',
              },
            },
            {
              contextSnapshot: {
                path: ['subtitle'],
                string_contains: query.q,
                mode: 'insensitive',
              },
            },
          ],
        },
      ];
    }

    const [total, rows, totals] = await this.database.$transaction([
      this.database.conversation.count({ where }),
      this.database.conversation.findMany({
        where,
        include: conversationInclude,
        // Pinned first, then recency.
        orderBy: [{ isPinned: 'desc' }, { lastMessageAt: { sort: 'desc', nulls: 'last' } }],
        skip: query.skip,
        take: query.take,
      }),
      this.database.conversationParticipant.aggregate({
        where: { userId, isArchived: false },
        _sum: { unreadCount: true },
        _count: { _all: true },
      }),
    ]);

    const unreadThreads = await this.database.conversationParticipant.count({
      where: { userId, isArchived: false, unreadCount: { gt: 0 } },
    });

    const lastMessages = await this.lastMessages(rows.map(row => row.id));

    return {
      data: rows.map(row => this.toRow(row, userId, lastMessages.get(row.id) ?? null)),
      meta: buildPageMeta(query, total, {
        // The badge is in four section headers, so the totals ship with the list rather than being recomputed from a page of it (5.2.3).
        unreadTotal: totals._sum.unreadCount ?? 0,
        unreadThreads,
      }),
    };
  }

  // ─── 5.3.2 One conversation ────────────────────────────────────────────────

  /** Used on a deep link, when the inbox has not been loaded. */
  async findOne(userId: string, conversationId: string) {
    const conversation = await this.requireParticipant(userId, conversationId);
    const lastMessages = await this.lastMessages([conversationId]);

    return this.toRow(conversation, userId, lastMessages.get(conversationId) ?? null);
  }

  // ─── 5.3.5 Start a plain DM ────────────────────────────────────────────────

  /** Returns the existing conversation when one already matches the uniqueness key, so the client opens the same thread either way (5.3.5). */
  async startDirect(userId: string, dto: StartThreadDto) {
    if (dto.recipientUserId === userId) {
      throw ApiException.unprocessable(
        ApiErrorCode.CANNOT_MESSAGE_YOURSELF,
        'You cannot start a conversation with yourself.',
      );
    }

    const recipient = await this.database.user.findUnique({
      where: { id: dto.recipientUserId },
      select: { id: true, isAnonymised: true },
    });

    if (!recipient || recipient.isAnonymised) {
      throw ApiException.notFound('That member could not be found.');
    }

    if (await this.blocking.isBlockedEitherWay(userId, dto.recipientUserId)) {
      throw ApiException.forbidden(
        ApiErrorCode.CONVERSATION_BLOCKED,
        'You cannot message this member.',
      );
    }

    // An open inbox is what makes an unsolicited DM acceptable at all (Circl Social's "Open Inbox"): without it, the two must already be connected.
    const profile = await this.database.userProfile.findUnique({
      where: { userId: dto.recipientUserId },
      select: { openInbox: true },
    });

    if (!profile?.openInbox) {
      const connected = await this.database.connectionRequest.findFirst({
        where: {
          state: 'ACCEPTED',
          OR: [
            { fromUserId: userId, toUserId: dto.recipientUserId },
            { fromUserId: dto.recipientUserId, toUserId: userId },
          ],
        },
        select: { id: true },
      });

      if (!connected) {
        throw ApiException.forbidden(
          ApiErrorCode.FORBIDDEN,
          'This member does not take direct messages. Send a connection request instead.',
        );
      }
    }

    const { conversation, created } = await this.factory.ensure({
      kind: ThreadKind.DIRECT,
      participantIds: [userId, dto.recipientUserId],
    });

    const full = await this.database.conversation.findUniqueOrThrow({
      where: { id: conversation.id },
      include: conversationInclude,
    });

    return { conversation: this.toRow(full, userId, null), created };
  }

  // ─── 5.3.6 Thread actions ──────────────────────────────────────────────────

  async setMuted(userId: string, conversationId: string, muted: boolean, until?: string) {
    await this.requireParticipant(userId, conversationId);

    await this.database.conversationParticipant.update({
      where: { conversationId_userId: { conversationId, userId } },
      // Mute silences the notification, not the count: a muted thread still increments unreadCount (5.4).
      data: { isMuted: muted, mutedUntil: muted && until ? new Date(until) : null },
    });

    return { isMuted: muted, mutedUntil: muted && until ? until : null };
  }

  async setArchived(userId: string, conversationId: string, archived: boolean) {
    await this.requireParticipant(userId, conversationId);

    await this.database.conversationParticipant.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { isArchived: archived },
    });

    // There is deliberately no "delete conversation": archive covers the intent, and a deleted thread is a deleted record of an agreement (5.3.6).
    return { isArchived: archived };
  }

  /** The account-wide badge, which the app icon and four headers all read. */
  async unreadTotal(userId: string) {
    const [totals, byConversation] = await Promise.all([
      this.database.conversationParticipant.aggregate({
        where: { userId, isArchived: false },
        _sum: { unreadCount: true },
      }),
      this.database.conversationParticipant.findMany({
        where: { userId, isArchived: false, unreadCount: { gt: 0 } },
        select: { conversationId: true, unreadCount: true },
      }),
    ]);

    return {
      total: totals._sum.unreadCount ?? 0,
      byConversation: Object.fromEntries(
        byConversation.map(row => [row.conversationId, row.unreadCount]),
      ),
    };
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  async requireParticipant(userId: string, conversationId: string): Promise<ConversationRow> {
    const conversation = await this.database.conversation.findUnique({
      where: { id: conversationId },
      include: conversationInclude,
    });

    if (!conversation) throw ApiException.notFound('That conversation could not be found.');

    if (!conversation.participants.some(participant => participant.userId === userId)) {
      throw ApiException.forbidden(
        ApiErrorCode.NOT_A_PARTICIPANT,
        'You are not part of this conversation.',
      );
    }

    return conversation;
  }

  private async lastMessages(conversationIds: string[]) {
    const map = new Map<
      string,
      {
        id: string;
        kind: MessageKind;
        body: string | null;
        senderId: string | null;
        status: string;
        sentAt: Date;
      }
    >();

    if (!conversationIds.length) return map;

    // One row per conversation.
    const messages = await this.database.message.findMany({
      where: { conversationId: { in: conversationIds } },
      orderBy: [{ conversationId: 'asc' }, { sentAt: 'desc' }],
      distinct: ['conversationId'],
      select: {
        id: true,
        conversationId: true,
        kind: true,
        body: true,
        senderId: true,
        status: true,
        sentAt: true,
        deletedAt: true,
      },
    });

    for (const message of messages) {
      map.set(message.conversationId, {
        id: message.id,
        kind: message.kind,
        body: message.deletedAt ? '' : message.body,
        senderId: message.senderId,
        status: message.status,
        sentAt: message.sentAt,
      });
    }

    return map;
  }

  private toRow(
    conversation: ConversationRow,
    userId: string,
    lastMessage: {
      id: string;
      kind: MessageKind;
      body: string | null;
      senderId: string | null;
      status: string;
      sentAt: Date;
    } | null,
  ) {
    const me = conversation.participants.find(participant => participant.userId === userId);
    const others = conversation.participants.filter(participant => participant.userId !== userId);
    const other = others.find(participant => participant.role === 'MEMBER') ?? others[0];
    const snapshot = (conversation.contextSnapshot as Record<string, unknown> | null) ?? null;

    const participantView: (AuthorView & { isOnline: boolean; lastSeenAt: string | null }) | null =
      other
        ? {
            ...toAuthorView(other.user, { sign: this.media.sign }),
            // Nobody is "online" without a live socket; the gateway overlays that.
            isOnline: false,
            lastSeenAt: other.user.sessions?.[0]?.lastActiveAt.toISOString() ?? null,
          }
        : null;

    return {
      id: conversation.id,
      kind: conversation.kind,
      isPinned: conversation.isPinned,
      participant: participantView,
      participantCount: conversation.participants.length,
      context: this.toContextView(conversation, snapshot),
      label: this.labelFor(conversation, userId),
      lastMessage: lastMessage
        ? {
            id: lastMessage.id,
            kind: lastMessage.kind,
            body: lastMessage.body ?? '',
            senderId: lastMessage.senderId,
            isMine: lastMessage.senderId === userId,
            status: lastMessage.status,
            sentAt: lastMessage.sentAt.toISOString(),
          }
        : null,
      unreadCount: me?.unreadCount ?? 0,
      isTyping: false,
      isMuted: me?.isMuted ?? false,
      isArchived: me?.isArchived ?? false,
      // 3.6: true until BOTH people have sent at least one message.
      safetyNoticeRequired:
        conversation.kind === ThreadKind.CONNECT &&
        conversation.participants.some(participant => !participant.hasSentMessage),
      createdAt: conversation.createdAt.toISOString(),
      lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
    };
  }

  private toContextView(
    conversation: Conversation,
    snapshot: Record<string, unknown> | null,
  ): ContextView | null {
    if (!conversation.contextType) return null;

    return {
      type: conversation.contextType,
      id: conversation.contextId,
      title: (snapshot?.title as string) ?? '',
      subtitle: (snapshot?.subtitle as string) ?? null,
      thumbnailUrl: snapshot?.thumbnailKey
        ? this.media.sign(snapshot.thumbnailKey as string)
        : null,
      trailing: (snapshot?.trailing as string) ?? null,
      route: (snapshot?.route as string) ?? this.routeFor(conversation),
    };
  }

  private routeFor(conversation: Conversation): string | null {
    if (!conversation.contextId) return null;

    switch (conversation.contextType) {
      case ThreadContextType.REQUEST:
        return `/community/request/${conversation.contextId}`;
      case ThreadContextType.OFFER:
        return `/community/offer/${conversation.contextId}`;
      case ThreadContextType.PROFESSIONAL:
        return `/professionals/${conversation.contextId}`;
      case ThreadContextType.BOOKING:
        return `/bookings/${conversation.contextId}`;
      case ThreadContextType.CONNECT_PROFILE:
        return `/connect/profile/${conversation.contextId}`;
      case ThreadContextType.ITEM:
        return `/commerce/item/${conversation.contextId}`;
      case ThreadContextType.ORDER:
        return `/commerce/orders/${conversation.contextId}`;
      default:
        return null;
    }
  }

  private labelFor(conversation: ConversationRow, userId: string): ThreadLabel {
    if (conversation.kind === ThreadKind.SUPPORT) return 'CIRCL_TEAM';

    switch (conversation.contextType) {
      case ThreadContextType.REQUEST:
        // Whether this member offered or asked changes what the chip should say.
        return conversation.participants.some(p => p.userId === userId && p.role === 'MEMBER')
          ? 'ABOUT_REQUEST'
          : 'OFFERED_HELP';
      case ThreadContextType.OFFER:
        return 'OFFERED_HELP';
      case ThreadContextType.PROFESSIONAL:
      case ThreadContextType.BOOKING:
        return 'ABOUT_LISTING';
      case ThreadContextType.CONNECT_PROFILE:
        return 'ABOUT_CONNECTION';
      case ThreadContextType.ITEM:
      case ThreadContextType.ORDER:
        return 'ABOUT_ORDER';
      default:
        return null;
    }
  }
}
