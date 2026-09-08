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
 * The two counts a member is waiting on, in one place. They were computed in two and both sent as
 * `badge`, so the iOS icon flipped meaning depending on which push arrived last.
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
