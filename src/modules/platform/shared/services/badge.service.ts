import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/infrastructure';

export interface BadgeCounts {
  /** Unread rows in the notification list. */
  notifications: number;
  /** Unread messages across every unarchived thread. */
  messages: number;
  /** What the app icon should show: everything waiting for this member, in one number. */
  total: number;
}

/**
 * The two counts a member is waiting on, computed in one place.
 *
 * They were computed in two, and both were sent under the key `badge`: a notification push carried
 * the unread *notification* count and a message push carried the unread *message* count. The iOS
 * icon badge is set straight from that key, so it flipped between two different meanings depending
 * on which push arrived last, and neither was the number a member would expect to see.
 */
@Injectable()
export class BadgeService {
  constructor(private readonly database: PrismaService) {}

  async of(userId: string): Promise<BadgeCounts> {
    const [notifications, messages] = await Promise.all([
      this.database.notification.count({ where: { userId, isRead: false } }),
      this.database.conversationParticipant
        .aggregate({
          where: { userId, isArchived: false },
          _sum: { unreadCount: true },
        })
        .then(result => result._sum.unreadCount ?? 0),
    ]);

    return { notifications, messages, total: notifications + messages };
  }
}
