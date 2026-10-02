import { Injectable, Logger } from '@nestjs/common';
import { MessageKind, ThreadKind } from '@prisma/client';
import { stripFormatting } from '@/common';
import { PrismaService } from '@/infrastructure';
import { BadgeService } from '../../shared';
import { FcmService } from '@/modules/infrastructure/notification/providers/push/fcm.service';
import { NotificationPreferenceService } from '../../notifications';

/** Push delivery for messages (spec 5.6). */
@Injectable()
export class MessagePushService {
  private readonly logger = new Logger(MessagePushService.name);

  constructor(
    private readonly preferences: NotificationPreferenceService,
    private readonly database: PrismaService,
    private readonly fcm: FcmService,
    private readonly badges: BadgeService,
  ) {}

  /** Fire-and-forget: a push that fails must never fail the send that produced it. */
  notify(input: {
    conversationId: string;
    messageId: string;
    senderId: string;
    recipientIds: string[];
  }): void {
    void this.deliver(input).catch(error =>
      this.logger.warn(`Push for message ${input.messageId} failed: ${(error as Error).message}`),
    );
  }

  private async deliver(input: {
    conversationId: string;
    messageId: string;
    senderId: string;
    recipientIds: string[];
  }): Promise<void> {
    if (!input.recipientIds.length) return;

    const [conversation, message, sender, participants, devices] = await Promise.all([
      this.database.conversation.findUnique({
        where: { id: input.conversationId },
        // The group id travels with the push so several messages from one group collapse into one
        // notification rather than twenty.
        select: { kind: true, contextSnapshot: true, group: { select: { id: true, name: true } } },
      }),
      this.database.message.findUnique({
        where: { id: input.messageId },
        select: { kind: true, body: true, mentions: true },
      }),
      this.database.user.findUnique({
        where: { id: input.senderId },
        select: { firstName: true, lastName: true },
      }),
      this.database.conversationParticipant.findMany({
        where: { conversationId: input.conversationId, userId: { in: input.recipientIds } },
        select: { userId: true, isMuted: true, mutedUntil: true, unreadCount: true },
      }),
      // Every handset each recipient is signed in on, grouped below. A message that reaches only
      // the last device to register is a message the member misses on the one in their hand.
      this.database.pushDevice.findMany({
        where: { userId: { in: input.recipientIds } },
        select: { userId: true, token: true },
        orderBy: { lastSeenAt: 'desc' },
      }),
    ]);

    if (!conversation || !message) return;

    const isSupport = conversation.kind === ThreadKind.SUPPORT;
    const isGroup = conversation.kind === ThreadKind.GROUP;
    const senderName = `${sender?.firstName ?? 'Someone'} ${sender?.lastName?.charAt(0) ?? ''}`.trim();
    // A group's push is from the group, with the member who spoke in the body. Titled with the
    // sender alone it read as a direct message from somebody the member may not know, and three
    // groups and a DM all looked the same on a lock screen.
    const groupName =
      conversation.group?.name ??
      (conversation.contextSnapshot as { title?: string } | null)?.title ??
      'A group';
    // A mention reaches somebody who has muted the group. It is the one exception, and it is the
    // reason mute is worth having: a member can silence the chatter and still be called on.
    const mentioned = new Set(
      ((message.mentions as Array<{ userId?: string }> | null) ?? [])
        .map(mention => mention.userId)
        .filter((id): id is string => typeof id === 'string'),
    );
    const tokensByUser = new Map<string, string[]>();

    for (const device of devices) {
      tokensByUser.set(device.userId, [...(tokensByUser.get(device.userId) ?? []), device.token]);
    }

    const now = new Date();
    const dead: string[] = [];

    for (const participant of participants) {
      const muted =
        participant.isMuted && (!participant.mutedUntil || participant.mutedUntil > now);
      const wasMentioned = mentioned.has(participant.userId);

      if (muted && !wasMentioned) continue;

      const tokens = tokensByUser.get(participant.userId) ?? [];

      if (!tokens.length) continue;

      // The MESSAGES row of the matrix (6.1.3), not a boolean of its own.
      if (!(await this.preferences.allows(participant.userId, 'MESSAGES', 'push'))) continue;

      const counts = await this.badges.of(participant.userId);

      const { deadTokens } = await this.fcm.sendPushToMany(
        tokens,
        isSupport
          ? 'Circl'
          : wasMentioned && isGroup
            ? `${senderName} mentioned you in ${groupName}`
            : isGroup
              ? groupName
              : senderName,
        // Never the body on a support thread.
        isSupport
          ? 'You have a new message from the Circl team.'
          : isGroup && !wasMentioned
            ? `${sender?.firstName ?? 'Someone'}: ${this.preview(message)}`
            : this.preview(message),
        {
          // The three keys the client reads out of message.data (G14 15.1). MESSAGE pulls the
          // thread and re-reads the unread totals.
          type: 'MESSAGE',
          // The target triple, which is what the client routes on. `targetParentId` is the group,
          // so several messages from one group collapse into one notification rather than twenty.
          targetType: 'CONVERSATION',
          targetId: input.conversationId,
          ...(conversation.group ? { targetParentId: conversation.group.id } : {}),
          // So the tap opens the thread directly rather than the inbox.
          conversationId: input.conversationId,
          // An in-app path, so a new kind becomes tappable without an app release.
          route: `/messages/${input.conversationId}`,
          messageId: input.messageId,
          // Per conversation, so twenty messages are one notification.
          collapseKey: input.conversationId,
          // The same three keys a notification push carries, meaning the same three things.
          badge: String(counts.total),
          unreadNotifications: String(counts.notifications),
          unreadMessages: String(counts.messages),
        },
      );

      dead.push(...deadTokens);
    }

    // Reinstalled, signed out elsewhere, or rotated. Dropped by token, so the devices that did
    // receive the message keep theirs.
    if (dead.length) {
      await this.database.pushDevice.deleteMany({ where: { token: { in: dead } } });
    }
  }

  /** Renders the kinds that have no body as what they are, not as a blank line. */
  private preview(message: { kind: MessageKind; body: string | null }): string {
    switch (message.kind) {
      case MessageKind.IMAGE:
        return 'Photo';
      case MessageKind.VIDEO:
        return 'Video';
      case MessageKind.AUDIO:
        return 'Voice note';
      default:
        // A lock screen renders nothing, so `bring *ID*` would show the member the markers.
        return stripFormatting(message.body ?? '').slice(0, 140) || 'New message';
    }
  }
}
