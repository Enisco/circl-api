import { Injectable, Logger } from '@nestjs/common';
import { NotificationBucket, NotificationKind, Prisma } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { buildPageMeta, toJsonOrUndefined } from '@/common';
import { authorSelect, MediaService, toAuthorView } from '../../shared';
import { ListNotificationsDto } from '../dtos';

/** What a section hands over when something happens worth telling somebody about. */
export interface RaiseNotificationInput {
  userId: string;
  kind: NotificationKind;
  /** The preference category that silences it (6.1.3). */
  categoryCode: string;
  title: string;
  body?: string | null;
  route?: string | null;
  actorId?: string | null;
  metadata?: Record<string, unknown>;
}

/** The bucket boundaries, in the member's own timezone (D32). */
const bucketFor = (createdAt: Date, now: Date, timezone: string): NotificationBucket => {
  const startOfLocalDay = (at: Date): number => {
    // `en-CA` formats as YYYY-MM-DD, which is the one locale that parses back cleanly.
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);

    return Date.parse(`${date}T00:00:00Z`);
  };

  const today = startOfLocalDay(now);
  const created = startOfLocalDay(createdAt);

  if (created >= today) return NotificationBucket.TODAY;
  if (created >= today - 6 * 86_400_000) return NotificationBucket.THIS_WEEK;

  return NotificationBucket.EARLIER;
};

/** The in-app notification list (6.1). */
@Injectable()
export class NotificationFeedService {
  private readonly logger = new Logger(NotificationFeedService.name);

  constructor(
    private readonly database: PrismaService,
    private readonly media: MediaService,
  ) {}

  /** Records a notification without blocking or failing the caller. */
  raise(input: RaiseNotificationInput): void {
    // Nobody is notified about their own action.
    if (input.actorId && input.actorId === input.userId) return;

    void this.database.notification
      .create({
        data: {
          userId: input.userId,
          kind: input.kind,
          categoryCode: input.categoryCode,
          title: input.title,
          body: input.body ?? null,
          route: input.route ?? null,
          actorId: input.actorId ?? null,
          metadata: toJsonOrUndefined(input.metadata),
        },
      })
      .catch(error => this.logger.warn(`Notification not recorded: ${(error as Error).message}`));
  }

  async list(userId: string, query: ListNotificationsDto) {
    const where: Prisma.NotificationWhereInput = {
      userId,
      ...(query.unreadOnly ? { isRead: false } : {}),
    };

    // The ordering is an expression, not a column: VERIFICATION pins to the top regardless of age, because it is the one kind that can block a member from doing something (6.1.1).
    const [ordered, total, unreadTotal, timezone] = await Promise.all([
      this.database.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM notifications
        WHERE user_id = ${userId}
          ${query.unreadOnly ? Prisma.sql`AND is_read = false` : Prisma.empty}
        ORDER BY (kind = 'VERIFICATION') DESC, created_at DESC
        LIMIT ${query.perPage} OFFSET ${query.skip}
      `,
      this.database.notification.count({ where }),
      this.unreadTotal(userId),
      this.timezoneOf(userId),
    ]);

    const ids = ordered.map(row => row.id);

    const hydrated = await this.database.notification.findMany({
      where: { id: { in: ids } },
      include: { actor: { select: authorSelect } },
    });

    // `IN` returns no order of its own, so the SQL ordering is reapplied here.
    const byId = new Map(hydrated.map(row => [row.id, row]));
    const rows = ids.map(id => byId.get(id)!).filter(Boolean);

    const now = new Date();

    return {
      data: rows.map(row => ({
        id: row.id,
        kind: row.kind,
        title: row.title,
        body: row.body,
        bucket: bucketFor(row.createdAt, now, timezone),
        isRead: row.isRead,
        route: row.route,
        actor: row.actor ? toAuthorView(row.actor, { sign: this.media.sign }) : null,
        createdAt: row.createdAt.toISOString(),
      })),
      // Account-wide, and unaffected by `unreadOnly` or paging: it backs the header badge, the same rule as messaging's `unread.total` (5.3.1).
      meta: buildPageMeta(query, total, { unreadTotal }),
    };
  }

  /** The badge (6.1.4). */
  async unreadTotal(userId: string): Promise<number> {
    return this.database.notification.count({ where: { userId, isRead: false } });
  }

  async markRead(userId: string, id: string) {
    // Scoped by userId in the same statement rather than read-then-check, so a guessed id touches nothing.
    await this.database.notification.updateMany({
      where: { id, userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });

    return { data: { unreadTotal: await this.unreadTotal(userId) } };
  }

  async markAllRead(userId: string) {
    await this.database.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });

    // Whatever remains rather than an assumed 0: a notification raised between the update and this count is genuinely unread (6.1.2).
    return { data: { unreadTotal: await this.unreadTotal(userId) } };
  }

  /** The member's city timezone, which is the closest thing to theirs we hold. */
  private async timezoneOf(userId: string): Promise<string> {
    const profile = await this.database.userProfile.findUnique({
      where: { userId },
      select: { city: { select: { timezone: true } } },
    });

    return profile?.city?.timezone ?? 'Europe/London';
  }
}
