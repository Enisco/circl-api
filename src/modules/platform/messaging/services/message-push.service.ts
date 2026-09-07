import { Injectable, Logger } from '@nestjs/common';
import { MessageKind, ThreadKind } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
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
        select: { kind: true, contextSnapshot: true },
      }),
      this.database.message.findUnique({
        where: { id: input.messageId },
        select: { kind: true, body: true },
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
    const tokensByUser = new Map<string, string[]>();

    for (const device of devices) {
      tokensByUser.set(device.userId, [...(tokensByUser.get(device.userId) ?? []), device.token]);
    }

    const now = new Date();
    const dead: string[] = [];

    for (const participant of participants) {
      const muted =
        participant.isMuted && (!participant.mutedUntil || participant.mutedUntil > now);

      if (muted) continue;

      const tokens = tokensByUser.get(participant.userId) ?? [];

      if (!tokens.length) continue;

      // The MESSAGES row of the matrix (6.1.3), not a boolean of its own.
      if (!(await this.preferences.allows(participant.userId, 'MESSAGES', 'push'))) continue;

      const total = await this.database.conversationParticipant.aggregate({
        where: { userId: participant.userId, isArchived: false },
        _sum: { unreadCount: true },
      });

      const { deadTokens } = await this.fcm.sendPushToMany(
        tokens,
        isSupport
          ? 'Circl'
          : `${sender?.firstName ?? 'Someone'} ${sender?.lastName?.charAt(0) ?? ''}`.trim(),
        // Never the body on a support thread.
        isSupport ? 'You have a new message from the Circl team.' : this.preview(message),
        {
          // The three keys the client reads out of message.data (G14 15.1). MESSAGE pulls the
          // thread and re-reads the unread totals.
          type: 'MESSAGE',
          // So the tap opens the thread directly rather than the inbox.
          conversationId: input.conversationId,
          // An in-app path, so a new kind becomes tappable without an app release.
          route: `/messages/${input.conversationId}`,
          messageId: input.messageId,
          // Per conversation, so twenty messages are one notification.
          collapseKey: input.conversationId,
          badge: String(total._sum.unreadCount ?? 0),
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
        return (message.body ?? '').slice(0, 140) || 'New message';
    }
  }
}
