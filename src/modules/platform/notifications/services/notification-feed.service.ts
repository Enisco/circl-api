import { Injectable, Logger } from '@nestjs/common';
import { NotificationBucket, NotificationKind, Prisma } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { buildPageMeta, toJsonOrUndefined } from '@/common';
import { authorSelect, MediaService, toAuthorView } from '../../shared';
import { FcmService } from '@/modules/infrastructure/notification/providers/push/fcm.service';
import { ListNotificationsDto } from '../dtos';
import { NotificationPreferenceService } from './notification-preference.service';

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
  /**
   * Collapses repeats onto one row instead of one per actor. Fifty likes on a post is one
   * notification that says fifty; fifty rows is how a member stops reading the list at all.
   * Two notifications collapse together when this key matches and the row is still unread.
   */
  collapseKey?: string;
  /** Renders the collapsed row: `(count, latestActorName) => title`. */
  collapsedTitle?: (count: number, actor: string | null) => string;
  /** The actor's display name, for `collapsedTitle`. */
  actorTitle?: string | null;
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
    private readonly preferences: NotificationPreferenceService,
    private readonly fcm: FcmService,
  ) {}

  /** Records a notification without blocking or failing the caller. */
  raise(input: RaiseNotificationInput): void {
    // Nobody is notified about their own action.
    if (input.actorId && input.actorId === input.userId) return;

    void this.write(input)
      // Without the push the row exists and nothing on the member's device changes, so the header
      // badge only moves when they happen to reopen the list (G14 15.1).
      .then(pushed => (pushed ? this.push(pushed) : undefined))
      .catch(error => this.logger.warn(`Notification not recorded: ${(error as Error).message}`));
  }

  /**
   * Writes the row, folding into an existing unread one where the caller asked for collapsing.
   * Returns what should be pushed, which for a collapsed row is the updated title rather than the
   * original, so the phone says "3 people liked your post" rather than buzzing three times with
   * the same sentence.
   */
  private async write(input: RaiseNotificationInput): Promise<RaiseNotificationInput | null> {
    if (input.collapseKey) {
      const existing = await this.database.notification.findFirst({
        where: {
          userId: input.userId,
          kind: input.kind,
          isRead: false,
          metadata: { path: ['collapseKey'], equals: input.collapseKey },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, metadata: true },
      });

      if (existing) {
        const previous = (existing.metadata as { count?: number } | null)?.count ?? 1;
        const count = previous + 1;
        const title = input.collapsedTitle?.(count, input.actorTitle ?? null) ?? input.title;

        await this.database.notification.update({
          where: { id: existing.id },
          data: {
            title,
            body: input.body ?? null,
            actorId: input.actorId ?? null,
            // Moves back to the top of the list: the newest like is why it is worth looking again.
            createdAt: new Date(),
            metadata: toJsonOrUndefined({ ...input.metadata, collapseKey: input.collapseKey, count }),
          },
        });

        return { ...input, title };
      }
    }

    await this.database.notification.create({
      data: {
        userId: input.userId,
        kind: input.kind,
        categoryCode: input.categoryCode,
        title: input.title,
        body: input.body ?? null,
        route: input.route ?? null,
        actorId: input.actorId ?? null,
        metadata: toJsonOrUndefined(
          input.collapseKey
            ? { ...input.metadata, collapseKey: input.collapseKey, count: 1 }
            : input.metadata,
        ),
      },
    });

    return input;
  }

  /** Fire-and-forget, like the row itself: a push that fails must never fail what raised it. */
  private async push(input: RaiseNotificationInput): Promise<void> {
    try {
      // The category's own row of the matrix (6.1.3), not a switch of its own.
      if (!(await this.preferences.allows(input.userId, input.categoryCode, 'push'))) return;

      const prefs = await this.database.userNotificationPrefs.findUnique({
        where: { userId: input.userId },
        select: { devicePushToken: true },
      });

      if (!prefs?.devicePushToken) return;

      await this.fcm.sendPush(prefs.devicePushToken, input.title, input.body ?? '', {
        // Anything other than MESSAGE refreshes the notification badge, so the kind travels as-is.
        type: input.kind,
        // An in-app path or nothing. A null route is a row that marks itself read and goes nowhere.
        ...(input.route ? { route: input.route } : {}),
        badge: String(await this.unreadTotal(input.userId)),
      });
    } catch (error) {
      this.logger.warn(`Notification push failed: ${(error as Error).message}`);
    }
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
