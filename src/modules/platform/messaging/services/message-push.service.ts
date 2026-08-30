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

    const [conversation, message, sender, participants, prefs] = await Promise.all([
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
      this.database.userNotificationPrefs.findMany({
        where: { userId: { in: input.recipientIds } },
        select: { userId: true, devicePushToken: true },
      }),
    ]);

    if (!conversation || !message) return;

    const isSupport = conversation.kind === ThreadKind.SUPPORT;
    const prefsByUser = new Map(prefs.map(row => [row.userId, row]));
    const now = new Date();

    for (const participant of participants) {
      const muted =
        participant.isMuted && (!participant.mutedUntil || participant.mutedUntil > now);

      if (muted) continue;

      const pref = prefsByUser.get(participant.userId);

      if (!pref?.devicePushToken) continue;

      // The MESSAGES row of the matrix (6.1.3), not a boolean of its own.
      if (!(await this.preferences.allows(participant.userId, 'MESSAGES', 'push'))) continue;

      const total = await this.database.conversationParticipant.aggregate({
        where: { userId: participant.userId, isArchived: false },
        _sum: { unreadCount: true },
      });

      await this.fcm.sendPush(
        pref.devicePushToken,
        isSupport ? 'Circl' : `${sender?.firstName ?? 'Someone'} ${sender?.lastName?.charAt(0) ?? ''}`.trim(),
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
