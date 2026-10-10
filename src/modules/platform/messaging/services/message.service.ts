import { Injectable } from '@nestjs/common';
import { MediaType, MessageKind, MessageStatus, Prisma, ThreadKind } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException, toJson } from '@/common';
import {
  BlockingService,
  MediaService,
  authorSelect,
  displayNameOf,
  toAuthorView,
  toMediaViews,
} from '../../shared';
import { ListMessagesDto, MentionDto, SendMessageDto } from '../dtos/message.dto';
import { ConversationService } from './conversation.service';

/** How long a sender has to withdraw or edit what they said. One window, one definition (5.3.6). */
const DELETE_WINDOW_MS = 15 * 60 * 1000;

const messageInclude = {
  sender: { select: authorSelect },
  attachments: { include: { media: true }, orderBy: { position: 'asc' } },
  // The quote is resolved rather than copied, so a withdrawn original quotes as withdrawn.
  replyTo: {
    select: {
      id: true,
      kind: true,
      body: true,
      deletedAt: true,
      sender: { select: authorSelect },
    },
  },
  // Aggregated on the way out: one row per member would ship a megabyte to a 400-member group.
  reactions: { select: { emoji: true, userId: true } },
} satisfies Prisma.MessageInclude;

/**
 * A mention as stored. The display name is kept with it rather than resolved on read, because the
 * body already contains the literal "@Ada Obi" at that offset: resolving live would let the array
 * and the text it points into disagree the day somebody changes their name.
 */
export interface StoredMention {
  userId: string;
  displayName: string;
  offset: number;
  length: number;
}

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

  /**
   * The order is total, `(sentAt, id)`: two messages can share a timestamp, and a `sentAt`-only
   * cursor skipped the anchor's twin. `hasMore` is counted by fetching one row more than asked.
   */
  async history(userId: string, conversationId: string, query: ListMessagesDto) {
    // Reading, not taking part: an open group's thread is readable by somebody who has not joined.
    // Sending, the read cursor and everything else below still require participation.
    await this.conversations.requireReadable(userId, conversationId);

    return this.page(userId, conversationId, query);
  }

  /**
   * The same page, with **no authorisation of its own**.
   *
   * For the admin API, where the right to read is a permission and a recorded reason rather than
   * membership of the thread. Participation is the wrong test there: a Guard case assigned to
   * somebody on holiday has to be readable by their colleague, and R7 grants that to anybody
   * holding `guard:read` — so requiring participation made an unassigned or unattended case
   * unreadable by the people whose job it is.
   *
   * The caller is responsible for the permission check, the reason, and the audit entry. Named at
   * length on purpose: nothing should reach for this casually, and nothing on the member side has
   * any business calling it at all.
   */
  async pageWithoutAuthorisation(viewerId: string, conversationId: string, query: ListMessagesDto) {
    return this.page(viewerId, conversationId, query);
  }

  /**
   * Reads a page and nothing else: no read receipts, no unread counts, no presence, no participant
   * row. Staff reading a member's thread must not change anything the member can see (S9.4).
   */
  private async page(userId: string, conversationId: string, query: ListMessagesDto) {
    // `since` pages with `after`. `before` would ask for changes older than the window itself.
    if (query.since && query.before) {
      throw ApiException.badRequest(
        ApiErrorCode.VALIDATION_FAILED,
        '`since` reads forwards, so it pages with `after`, not `before`.',
        { details: [{ field: 'before', message: 'Use after to page a since result.' }] },
      );
    }

    const limit = Math.min(query.limit ?? 30, 100);
    const anchor = await this.anchor(query.before ?? query.after);
    // `since` and `after` both read forwards; only the default and `before` scroll backwards.
    const ascending = Boolean(query.after || query.since);
    const direction = ascending ? 'asc' : 'desc';

    const where: Prisma.MessageWhereInput = {
      conversationId,
      ...(anchor ? { AND: [cursorClause(anchor, Boolean(query.after))] } : {}),
      // Changed, not created, so a withdrawn message comes back as a tombstone.
      ...(query.since
        ? {
            OR: [
              { sentAt: { gte: new Date(query.since) } },
              { editedAt: { gte: new Date(query.since) } },
              { deletedAt: { gte: new Date(query.since) } },
            ],
          }
        : {}),
    };

    const rows = await this.database.message.findMany({
      where,
      include: messageInclude,
      // Newest first, because a chat scrolls backwards. `id` breaks ties so the order is total.
      orderBy: [{ sentAt: direction }, { id: direction }],
      // One more than asked for, which is how `hasMore` is known rather than inferred.
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: page.map(row => this.toView(row, userId)),
      meta: {
        hasMore,
        // The last row of the page, whichever direction it was read: what the next `before`,
        // `after` or `since` should carry. Null when there is nothing more.
        nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
        oldestId: ascending ? (page[0]?.id ?? null) : (page.at(-1)?.id ?? null),
        newestId: ascending ? (page.at(-1)?.id ?? null) : (page[0]?.id ?? null),
      },
    };
  }

  /** 422 rather than a dangling quote: a reply to something in another thread is a mistake. */
  private async resolveReplyTo(
    conversationId: string,
    replyToMessageId?: string,
  ): Promise<string | null> {
    if (!replyToMessageId) return null;

    const quoted = await this.database.message.findUnique({
      where: { id: replyToMessageId },
      select: { conversationId: true },
    });

    if (!quoted || quoted.conversationId !== conversationId) {
      throw ApiException.unprocessable(
        ApiErrorCode.MESSAGE_NOT_IN_CONVERSATION,
        'That message is not in this conversation.',
        { details: [{ field: 'replyToMessageId', message: 'Not a message in this thread.' }] },
      );
    }

    return replyToMessageId;
  }

  /**
   * Only the people in this thread may be mentioned, and anybody else is dropped rather than
   * refused: a mention of somebody who has left is not a reason to lose the message.
   */
  private async resolveMentions(
    conversation: { participants: Array<{ userId: string }> },
    mentions?: MentionDto[],
  ): Promise<StoredMention[]> {
    if (!mentions?.length) return [];

    const inThread = new Set(conversation.participants.map(participant => participant.userId));
    const wanted = [...new Set(mentions.map(mention => mention.userId))].filter(id =>
      inThread.has(id),
    );

    if (!wanted.length) return [];

    const users = await this.database.user.findMany({
      where: { id: { in: wanted } },
      select: { id: true, firstName: true, lastName: true },
    });
    const names = new Map(
      users.map(user => [user.id, displayNameOf(user.firstName, user.lastName)] as const),
    );

    return mentions
      .filter(mention => names.has(mention.userId))
      .map(mention => ({
        userId: mention.userId,
        displayName: names.get(mention.userId)!,
        offset: mention.offset,
        length: mention.length,
      }));
  }

  /**
   * The message being passed on, loaded only to carry its media across. The sender has to be able
   * to read it, or forwarding would be a way to pull an attachment out of a thread they are not in.
   */
  private async resolveForward(userId: string, forwardFromMessageId?: string) {
    if (!forwardFromMessageId) return null;

    const source = await this.database.message.findUnique({
      where: { id: forwardFromMessageId },
      select: {
        conversationId: true,
        deletedAt: true,
        attachments: { select: { mediaId: true }, orderBy: { position: 'asc' } },
      },
    });

    if (!source || source.deletedAt) {
      throw ApiException.notFound('That message could not be found.');
    }

    // Readable, not writable: forwarding out of an open group you only read is fine.
    await this.conversations.requireReadable(userId, source.conversationId);

    return source;
  }

  // ─── 5.3.4 Send ────────────────────────────────────────────────────────────

  /** The REST fallback for sending. */
  async send(userId: string, conversationId: string, dto: SendMessageDto) {
    const conversation = await this.conversations.requireParticipant(userId, conversationId);

    const others = conversation.participants
      .filter(participant => participant.userId !== userId)
      .map(participant => participant.userId);

    // A block is a thing between two people. Checking every other participant is right for a 1:1
    // and wrong for a group: it would stop a member speaking at all because they had blocked one
    // of five hundred, and it would cost one query per member on every send.
    if (conversation.kind !== ThreadKind.GROUP) {
      for (const other of others) {
        if (await this.blocking.isBlockedEitherWay(userId, other)) {
          throw ApiException.forbidden(
            ApiErrorCode.CONVERSATION_BLOCKED,
            'You cannot message this member.',
          );
        }
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

    // `attachmentIds` is the same array under the name an early client shipped (5.3.4).
    const attachments = await this.validateAttachments(
      userId,
      kind,
      dto.attachmentKeys ?? dto.attachmentIds,
    );

    const [replyToMessageId, mentions, forwarded] = await Promise.all([
      this.resolveReplyTo(conversationId, dto.replyToMessageId),
      this.resolveMentions(conversation, dto.mentions),
      this.resolveForward(userId, dto.forwardFromMessageId),
    ]);

    // Forwarding carries the original's media without a re-upload: the sender has the URL, not a
    // key they could hand back, and asking them to upload bytes they already have is a worse API.
    const carried = forwarded?.attachments ?? [];

    const message = await this.database.$transaction(async tx => {
      const created = await tx.message.create({
        data: {
          conversationId,
          senderId: userId,
          kind,
          body: body || null,
          clientId: dto.clientId,
          status: MessageStatus.SENT,
          replyToMessageId,
          mentions: mentions.length ? toJson(mentions) : undefined,
          isForwarded: dto.isForwarded === true || forwarded !== null,
          attachments: {
            create: [
              ...attachments.map((media, position) => ({ mediaId: media.id, position })),
              ...carried.map((attachment, index) => ({
                mediaId: attachment.mediaId,
                position: attachments.length + index,
              })),
            ],
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
      //
      // `isArchived` is cleared with it. A thread somebody filed away as done, written into again,
      // is not done: it returns to their inbox unread. Left archived the message lands where
      // nobody is looking and no badge counts it, because the account-wide unread totals only
      // read active rows.
      await tx.conversationParticipant.updateMany({
        where: { conversationId, userId: { in: others } },
        data: { unreadCount: { increment: 1 }, isArchived: false },
      });

      // Writing into a thread is the opposite of being finished with it.
      await tx.conversationParticipant.update({
        where: { conversationId_userId: { conversationId, userId } },
        data: { hasSentMessage: true, lastReadAt: created.sentAt, isArchived: false },
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

  /**
   * One event clears a backlog rather than one per message (5.4). `lastReadMessageId` is optional
   * because a thread nobody has spoken in has no message to name.
   */
  async markRead(userId: string, conversationId: string, lastReadMessageId?: string) {
    await this.conversations.requireParticipant(userId, conversationId);

    const anchor = lastReadMessageId
      ? await this.database.message.findUnique({
          where: { id: lastReadMessageId },
          select: { id: true, conversationId: true, sentAt: true },
        })
      : await this.database.message.findFirst({
          where: { conversationId },
          orderBy: { sentAt: 'desc' },
          select: { id: true, conversationId: true, sentAt: true },
        });

    // A named message that is not in this thread is still an error: the caller believed something
    // that is not true, and silently reading the whole thread instead would hide it.
    if (lastReadMessageId && (!anchor || anchor.conversationId !== conversationId)) {
      throw ApiException.notFound('That message could not be found.');
    }

    const now = new Date();

    if (!anchor) {
      // Nothing has been said yet. Record the visit, because "opened at" is still true, and
      // report honestly that no message was read.
      await this.database.conversationParticipant.update({
        where: { conversationId_userId: { conversationId, userId } },
        data: { unreadCount: 0, lastReadAt: now },
      });

      return { lastReadMessageId: null, readAt: now.toISOString(), unreadCount: 0 };
    }

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

  // ─── 5.3.6 Edit ────────────────────────────────────────────────────────────

  /**
   * Sender only, inside the same fifteen minutes as withdrawing, and text only: an attachment is
   * not edited, it is withdrawn and sent again. `editedAt` is what makes the bubble say "edited".
   */
  async edit(userId: string, conversationId: string, messageId: string, body: string) {
    await this.conversations.requireParticipant(userId, conversationId);

    const message = await this.database.message.findUnique({ where: { id: messageId } });

    if (!message || message.conversationId !== conversationId) {
      throw ApiException.notFound('That message could not be found.');
    }

    if (message.deletedAt) throw ApiException.deleted('This message');

    if (message.senderId !== userId) {
      throw ApiException.forbidden(ApiErrorCode.FORBIDDEN, 'You can only edit your own messages.');
    }

    if (message.kind !== MessageKind.TEXT) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'A photo or a voice note is withdrawn and sent again rather than edited.',
        { details: [{ field: 'body', message: 'Only a text message can be edited.' }] },
      );
    }

    if (Date.now() - message.sentAt.getTime() > DELETE_WINDOW_MS) {
      throw ApiException.forbidden(
        ApiErrorCode.EDIT_WINDOW_CLOSED,
        'The fifteen minutes for editing this message have passed.',
      );
    }

    const trimmed = body.trim();

    if (!trimmed) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'An edit cannot empty a message. Withdraw it instead.',
        { details: [{ field: 'body', message: 'This is required.' }] },
      );
    }

    const updated = await this.database.message.update({
      where: { id: messageId },
      // `since=` already promises anything whose editedAt moved, so the catch-up path needs
      // nothing beyond the column being set.
      data: { body: trimmed, editedAt: new Date() },
      include: messageInclude,
    });

    return this.toView(updated, userId);
  }

  // ─── 5.3.7 Reactions ───────────────────────────────────────────────────────

  /**
   * One per member per message, which is why this replaces rather than adds: sending a different
   * emoji is changing your mind, not reacting twice.
   */
  async react(userId: string, conversationId: string, messageId: string, emoji: string) {
    await this.conversations.requireParticipant(userId, conversationId);
    await this.messageInThread(conversationId, messageId);

    await this.database.messageReaction.upsert({
      where: { messageId_userId: { messageId, userId } },
      update: { emoji },
      create: { messageId, userId, emoji },
    });

    return this.reactionsOf(messageId, userId);
  }

  async unreact(userId: string, conversationId: string, messageId: string) {
    await this.conversations.requireParticipant(userId, conversationId);
    await this.messageInThread(conversationId, messageId);

    // Idempotent: taking back a reaction you never left is the state you asked for.
    await this.database.messageReaction.deleteMany({ where: { messageId, userId } });

    return this.reactionsOf(messageId, userId);
  }

  /** The aggregate the socket and both reaction routes answer with. */
  async reactionsOf(messageId: string, viewerId: string) {
    const rows = await this.database.messageReaction.findMany({
      where: { messageId },
      select: { emoji: true, userId: true },
    });

    return { messageId, reactions: this.aggregateReactions(rows, viewerId) };
  }

  private async messageInThread(conversationId: string, messageId: string) {
    const message = await this.database.message.findUnique({
      where: { id: messageId },
      select: { conversationId: true, deletedAt: true },
    });

    if (!message || message.conversationId !== conversationId) {
      throw ApiException.unprocessable(
        ApiErrorCode.MESSAGE_NOT_IN_CONVERSATION,
        'That message is not in this conversation.',
        { details: [{ field: 'messageId', message: 'Not a message in this thread.' }] },
      );
    }

    if (message.deletedAt) throw ApiException.deleted('This message');
  }

  /**
   * The same stored message as each of these callers must see it. `isMine` and `mine` on a
   * reaction are the reader's, not the sender's, so one serialisation cannot be broadcast to
   * everybody — which is exactly what made every member of a group see every message as their own.
   */
  async viewsFor(messageId: string, viewerIds: string[]) {
    const message = await this.database.message.findUnique({
      where: { id: messageId },
      include: messageInclude,
    });

    if (!message) return new Map<string, ReturnType<MessageService['toView']>>();

    return new Map(viewerIds.map(viewerId => [viewerId, this.toView(message, viewerId)] as const));
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

    // `id` as well as `sentAt`, because the cursor comparison is over both (see `history`).
    return this.database.message.findUnique({
      where: { id: messageId },
      select: { id: true, sentAt: true },
    });
  }

  /**
   * One row per emoji with a count, and `mine` for this caller alone. Never one row per member: a
   * 400-member group would ship a megabyte of reactions to render six chips.
   */
  private aggregateReactions(
    reactions: Array<{ emoji: string; userId: string }>,
    viewerId: string,
  ): Array<{ emoji: string; count: number; mine: boolean }> {
    if (!reactions.length) return [];

    const counts = new Map<string, { count: number; mine: boolean }>();

    for (const reaction of reactions) {
      const seen = counts.get(reaction.emoji) ?? { count: 0, mine: false };

      counts.set(reaction.emoji, {
        count: seen.count + 1,
        mine: seen.mine || reaction.userId === viewerId,
      });
    }

    // Most reacted first, which is the order the chips read in.
    return [...counts.entries()]
      .map(([emoji, row]) => ({ emoji, ...row }))
      .sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));
  }

  toView(message: MessageRow, viewerId: string) {
    const isDeleted = message.deletedAt !== null;
    const sender = message.sender ? toAuthorView(message.sender, { sign: this.media.sign }) : null;
    const quoted = message.replyTo;
    const mentions = (message.mentions as unknown as StoredMention[] | null) ?? null;

    return {
      id: message.id,
      conversationId: message.conversationId,
      clientId: message.clientId,
      kind: message.kind,
      body: isDeleted ? '' : (message.body ?? ''),
      /**
       * `name` is an alias of `displayName`, which every other author object in this API uses.
       * Kept for one release because a group bubble needs a name above it and the shipped client
       * reads `sender.name`.
       */
      sender: sender ? { ...sender, name: sender.displayName } : null,
      isMine: message.senderId === viewerId,
      attachments: isDeleted
        ? []
        : toMediaViews(
            message.attachments.map(attachment => attachment.media),
            this.media.sign,
          ),
      /**
       * A snapshot of what this answers, resolved rather than copied. Where the original was
       * withdrawn it comes back with `deletedAt` set and an empty body, which is what lets the
       * quote read "Message deleted" instead of resurfacing something somebody took back.
       */
      replyTo: quoted
        ? {
            id: quoted.id,
            kind: quoted.kind,
            body: quoted.deletedAt ? '' : (quoted.body ?? ''),
            sender: quoted.sender ? toAuthorView(quoted.sender, { sign: this.media.sign }) : null,
            deletedAt: quoted.deletedAt?.toISOString() ?? null,
          }
        : null,
      /** Echoed as stored, so a reader renders and taps without a lookup. Empty, never null. */
      mentions: isDeleted ? [] : (mentions ?? []),
      /** Aggregated, with `mine` answering for this caller alone. */
      reactions: this.aggregateReactions(message.reactions, viewerId),
      isForwarded: message.isForwarded,
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

/** A `sentAt`-only comparison drops every message sharing the anchor's timestamp. */
const cursorClause = (
  anchor: { id: string; sentAt: Date },
  forwards: boolean,
): Prisma.MessageWhereInput =>
  forwards
    ? {
        OR: [{ sentAt: { gt: anchor.sentAt } }, { sentAt: anchor.sentAt, id: { gt: anchor.id } }],
      }
    : {
        OR: [{ sentAt: { lt: anchor.sentAt } }, { sentAt: anchor.sentAt, id: { lt: anchor.id } }],
      };
