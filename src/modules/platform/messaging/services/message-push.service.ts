import { Injectable, Logger } from '@nestjs/common';
import { MessageKind, ThreadKind } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { FcmService } from '@/modules/infrastructure/notification/providers/push/fcm.service';

/**
 * Push delivery for messages (spec 5.6).
 *
 * | Recipient has a live socket, thread open | Socket only, no push |
 * | Live socket, thread not open             | Socket, plus an in-app notification |
 * | No socket                                | Push via the registered device token |
 *
 * Three rules here are not conveniences:
 *
 * Support threads carry NO message body in the payload. The whole point of that
 * channel is that it is private, and a lock-screen preview of "my landlord is
 * threatening me" defeats it — on the one screen most likely to be read by
 * whoever the member is hiding from.
 *
 * Muted threads produce no push at all. Mute silences the notification; the
 * unread count still moves, which is why the badge below is the account-wide
 * total rather than something derived from what was pushed.
 *
 * The collapse key is per conversation, so twenty messages in one thread replace
 * each other rather than becoming twenty notifications.
 */
@Injectable()
export class MessagePushService {
  private readonly logger = new Logger(MessagePushService.name);

  constructor(
    private readonly database: PrismaService,
    private readonly fcm: FcmService,
  ) {}

  /**
   * Fire-and-forget: a push that fails must never fail the send that produced
   * it. The message is already stored, and the recipient will see it on next
   * open regardless.
   */
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
        select: { userId: true, devicePushToken: true, newMessages: true },
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

      if (!pref?.devicePushToken || !pref.newMessages) continue;

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
          // So the tap opens the thread directly rather than the inbox.
          conversationId: input.conversationId,
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
