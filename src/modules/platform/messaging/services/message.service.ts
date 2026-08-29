import { Injectable } from '@nestjs/common';
import { MediaType, MessageKind, MessageStatus, Prisma, ThreadKind } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException } from '@/common';
import {
  BlockingService,
  MediaService,
  authorSelect,
  toAuthorView,
  toMediaViews,
} from '../../shared';
import { ListMessagesDto, SendMessageDto } from '../dtos/message.dto';
import { ConversationService } from './conversation.service';

/** Sender only, within 15 minutes (5.3.6). */
const DELETE_WINDOW_MS = 15 * 60 * 1000;

const messageInclude = {
  sender: { select: authorSelect },
  attachments: { include: { media: true }, orderBy: { position: 'asc' } },
} satisfies Prisma.MessageInclude;

type MessageRow = Prisma.MessageGetPayload<{ include: typeof messageInclude }>;

@Injectable()
export class MessageService {
  constructor(
    private readonly database: PrismaService,
    private readonly conversations: ConversationService,
    private readonly media: MediaService,
    private readonly blocking: BlockingService,
  ) {}

  // ─── 5.3.3 History ─────────────────────────────────────────────────────────

  async history(userId: string, conversationId: string, query: ListMessagesDto) {
    await this.conversations.requireParticipant(userId, conversationId);

    const limit = Math.min(query.limit ?? 30, 100);
    const anchor = await this.anchor(query.before ?? query.after);

    const where: Prisma.MessageWhereInput = {
      conversationId,
      ...(anchor && query.before ? { sentAt: { lt: anchor.sentAt } } : {}),
      ...(anchor && query.after ? { sentAt: { gt: anchor.sentAt } } : {}),
    };

    const rows = await this.database.message.findMany({
      where,
      include: messageInclude,
      // Newest first, because a chat scrolls backwards.
      orderBy: { sentAt: query.after ? 'asc' : 'desc' },
      take: limit,
    });

    return {
      data: rows.map(row => this.toView(row, userId)),
      meta: {
        hasMore: rows.length === limit,
        oldestId: rows.at(-1)?.id ?? null,
        newestId: rows[0]?.id ?? null,
      },
    };
  }

  // ─── 5.3.4 Send ────────────────────────────────────────────────────────────

  /** The REST fallback for sending. */
  async send(userId: string, conversationId: string, dto: SendMessageDto) {
    const conversation = await this.conversations.requireParticipant(userId, conversationId);

    const others = conversation.participants
      .filter(participant => participant.userId !== userId)
      .map(participant => participant.userId);

    for (const other of others) {
      if (await this.blocking.isBlockedEitherWay(userId, other)) {
        throw ApiException.forbidden(
          ApiErrorCode.CONVERSATION_BLOCKED,
          'You cannot message this member.',
        );
      }
    }

    const existing = await this.database.message.findUnique({
      where: { conversationId_clientId: { conversationId, clientId: dto.clientId } },
      include: messageInclude,
    });

    if (existing) return this.toView(existing, userId);

    const kind = dto.kind ?? MessageKind.TEXT;

    if (kind === MessageKind.SYSTEM) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'System messages are written by Circl, not by members.',
        { details: [{ field: 'kind', message: 'Not a valid message kind.' }] },
      );
    }

    const body = dto.body?.trim() ?? '';

    if (kind === MessageKind.TEXT && !body) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'Write something before sending.',
        { details: [{ field: 'body', message: 'This is required.' }] },
      );
    }

    // A caption on media is capped shorter than a text message (5.9).
    if (kind !== MessageKind.TEXT && body.length > 1000) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'A caption can be up to 1000 characters.',
        { details: [{ field: 'body', message: 'Up to 1000 characters.' }] },
      );
    }

    const attachments = await this.validateAttachments(userId, kind, dto.attachmentKeys);

    const message = await this.database.$transaction(async tx => {
      const created = await tx.message.create({
        data: {
          conversationId,
          senderId: userId,
          kind,
          body: body || null,
          clientId: dto.clientId,
          status: MessageStatus.SENT,
          attachments: {
            create: attachments.map((media, position) => ({ mediaId: media.id, position })),
          },
          // Per-participant receipts, so the server stays the only writer of message status (5.2.4).
          receipts: {
            create: conversation.participants.map(participant => ({
              userId: participant.userId,
              ...(participant.userId === userId ? { readAt: new Date() } : {}),
            })),
          },
        },
        include: messageInclude,
      });

      await this.media.attach(tx, attachments, 'MESSAGE', created.id);

      await tx.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: created.sentAt, messageCount: { increment: 1 } },
      });

      // unreadCount is held per participant rather than derived at read time: counting messages after lastReadAt on every inbox load is the query that gets slow first (5.4).
      await tx.conversationParticipant.updateMany({
        where: { conversationId, userId: { in: others } },
        data: { unreadCount: { increment: 1 } },
      });

      await tx.conversationParticipant.update({
        where: { conversationId_userId: { conversationId, userId } },
        data: { hasSentMessage: true, lastReadAt: created.sentAt },
      });

      return created;
    });

    return this.toView(message, userId);
  }

  /** The other participants in a thread, for delivery and push decisions. */
  async recipientIdsOf(conversationId: string, senderId: string): Promise<string[]> {
    const rows = await this.database.conversationParticipant.findMany({
      where: { conversationId, userId: { not: senderId } },
      select: { userId: true },
    });

    return rows.map(row => row.userId);
  }

  // ─── 5.4 Read receipts ─────────────────────────────────────────────────────

  /** One event clears a backlog rather than one per message (5.4). */
  async markRead(userId: string, conversationId: string, lastReadMessageId: string) {
    await this.conversations.requireParticipant(userId, conversationId);

    const anchor = await this.database.message.findUnique({
      where: { id: lastReadMessageId },
      select: { id: true, conversationId: true, sentAt: true },
    });

    if (!anchor || anchor.conversationId !== conversationId) {
      throw ApiException.notFound('That message could not be found.');
    }

    const now = new Date();

    await this.database.$transaction(async tx => {
      await tx.messageReceipt.updateMany({
        where: {
          userId,
          readAt: null,
          message: { conversationId, sentAt: { lte: anchor.sentAt } },
        },
        data: { readAt: now, deliveredAt: now },
      });

      await tx.conversationParticipant.update({
        where: { conversationId_userId: { conversationId, userId } },
        data: { unreadCount: 0, lastReadAt: now, lastReadMessageId: anchor.id },
      });

      // A message is READ once every recipient has read it.
      const conversation = await tx.conversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: { kind: true, participants: { select: { userId: true } } },
      });

      if (conversation.kind === ThreadKind.SUPPORT) return;

      const recipientCount = conversation.participants.length - 1;

      if (recipientCount < 1) return;

      const candidates = await tx.message.findMany({
        where: {
          conversationId,
          sentAt: { lte: anchor.sentAt },
          status: { not: MessageStatus.READ },
          senderId: { not: null },
        },
        select: { id: true, senderId: true },
      });

      for (const message of candidates) {
        const readCount = await tx.messageReceipt.count({
          where: {
            messageId: message.id,
            userId: { not: message.senderId! },
            readAt: { not: null },
          },
        });

        if (readCount >= recipientCount) {
          await tx.message.update({
            where: { id: message.id },
            data: { status: MessageStatus.READ },
          });
        }
      }
    });

    return { lastReadMessageId: anchor.id, readAt: now.toISOString(), unreadCount: 0 };
  }

  /** DELIVERED: it reached the recipient's device (socket delivery or push). */
  async markDelivered(userId: string, messageIds: string[]) {
    if (!messageIds.length) return;

    const now = new Date();

    await this.database.messageReceipt.updateMany({
      where: { userId, messageId: { in: messageIds }, deliveredAt: null },
      data: { deliveredAt: now },
    });

    await this.database.message.updateMany({
      where: { id: { in: messageIds }, status: MessageStatus.SENT },
      data: { status: MessageStatus.DELIVERED },
    });
  }

  // ─── 5.3.6 Delete ──────────────────────────────────────────────────────────

  /** A deleted message is a tombstone, not a gap: `deletedAt` is set and the body and attachments are emptied, but the row stays. */
  async remove(userId: string, conversationId: string, messageId: string) {
    await this.conversations.requireParticipant(userId, conversationId);

    const message = await this.database.message.findUnique({ where: { id: messageId } });

    if (!message || message.conversationId !== conversationId) {
      throw ApiException.notFound('That message could not be found.');
    }

    if (message.senderId !== userId) {
      throw ApiException.forbidden(
        ApiErrorCode.FORBIDDEN,
        'You can only delete your own messages.',
      );
    }

    if (Date.now() - message.sentAt.getTime() > DELETE_WINDOW_MS) {
      throw ApiException.forbidden(
        ApiErrorCode.MESSAGE_DELETE_WINDOW_PASSED,
        'Messages can only be deleted within 15 minutes of sending.',
      );
    }

    await this.database.$transaction(async tx => {
      await tx.message.update({
        where: { id: messageId },
        data: { deletedAt: new Date(), body: null },
      });

      await tx.messageAttachment.deleteMany({ where: { messageId } });
      await this.media.releaseOwner(tx, 'MESSAGE', messageId);
    });

    const fresh = await this.database.message.findUniqueOrThrow({
      where: { id: messageId },
      include: messageInclude,
    });

    return this.toView(fresh, userId);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async validateAttachments(
    userId: string,
    kind: MessageKind,
    attachmentKeys: string[] | undefined,
  ) {
    if (kind === MessageKind.TEXT) return [];

    if (!attachmentKeys?.length) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'Attach a file to send this kind of message.',
        { details: [{ field: 'attachmentKeys', message: 'This is required.' }] },
      );
    }

    const media = await this.media.validate(attachmentKeys, userId, {
      maxImages: 5,
      allowVideo: true,
      allowAudio: true,
    });

    const expected =
      kind === MessageKind.IMAGE
        ? MediaType.IMAGE
        : kind === MessageKind.VIDEO
          ? MediaType.VIDEO
          : MediaType.AUDIO;

    if (media.some(item => item.type !== expected)) {
      throw ApiException.unprocessable(
        ApiErrorCode.MEDIA_TYPE_NOT_ALLOWED,
        'Those attachments do not match the message type.',
        { details: [{ field: 'attachmentKeys', message: 'Wrong file type for this message.' }] },
      );
    }

    return media;
  }

  private async anchor(messageId: string | undefined) {
    if (!messageId) return null;

    return this.database.message.findUnique({
      where: { id: messageId },
      select: { sentAt: true },
    });
  }

  toView(message: MessageRow, viewerId: string) {
    const isDeleted = message.deletedAt !== null;

    return {
      id: message.id,
      conversationId: message.conversationId,
      clientId: message.clientId,
      kind: message.kind,
      body: isDeleted ? '' : (message.body ?? ''),
      sender: message.sender ? toAuthorView(message.sender, { sign: this.media.sign }) : null,
      isMine: message.senderId === viewerId,
      attachments: isDeleted
        ? []
        : toMediaViews(
            message.attachments.map(attachment => attachment.media),
            this.media.sign,
          ),
      status: message.status,
      systemType: message.systemType,
      systemData: message.systemData,
      // D26: the server stamps this.
      sentAt: message.sentAt.toISOString(),
      // D27: nullable and unused at launch, so adding editing later is not a migration.
      editedAt: message.editedAt?.toISOString() ?? null,
      deletedAt: message.deletedAt?.toISOString() ?? null,
    };
  }
}

export type MessageView = ReturnType<MessageService['toView']>;
