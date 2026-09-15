import { Injectable, Logger } from '@nestjs/common';
import { NotificationBucket, NotificationKind, Prisma } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { buildPageMeta, toJsonOrUndefined } from '@/common';
import {
  authorSelect,
  BadgeService,
  countryNameOf,
  displayNameOf,
  MediaService,
  toAuthorView,
} from '../../shared';
import { FcmService } from '@/modules/infrastructure/notification/providers/push/fcm.service';
import { ListNotificationsDto } from '../dtos';
import { NotificationPreferenceService } from './notification-preference.service';

/** What the notification is about, so a client can route without parsing `route` (6.1.1). */
export type NotificationTargetType =
  | 'REQUEST'
  | 'UPDATE'
  | 'GUIDE'
  | 'GROUP'
  | 'GROUP_POST'
  | 'CONVERSATION'
  | 'BOOKING'
  | 'ORDER'
  | 'CONNECT_REQUEST'
  | 'DEAL'
  | 'PROFILE'
  | 'VERIFICATION';

export interface NotificationTarget {
  type: NotificationTargetType;
  id: string;
  /**
   * Set only where the target cannot be opened without it: a group post needs its group, since
   * the replies route is `/community/groups/{groupId}/posts/{postId}/replies`.
   */
  parent?: { type: NotificationTargetType; id: string };
}

/** A written notification, on its way to the device. The id is what a tap reports back as read. */
interface PushableNotification extends RaiseNotificationInput {
  notificationId: string;
}

/** What a section hands over when something happens worth telling somebody about. */
export interface RaiseNotificationInput {
  userId: string;
  kind: NotificationKind;
  /** The preference category that silences it (6.1.3). */
  categoryCode: string;
  title: string;
  body?: string | null;
  route?: string | null;
  /** Set it wherever there is one. Leaving it to each caller's metadata is how they drifted. */
  target?: NotificationTarget | null;
  actorId?: string | null;
  metadata?: Record<string, unknown>;
  /** Collapses repeats onto one unread row: fifty likes is one notification that says fifty. */
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
    private readonly badges: BadgeService,
  ) {}

  /** The actor's name for a title. Here so five sections fall back to the same word. */
  async actorName(userId: string): Promise<string> {
    const actor = await this.database.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true, isAnonymised: true },
    });

    if (!actor || actor.isAnonymised) return 'Someone';

    return displayNameOf(actor.firstName, actor.lastName) || 'Someone';
  }

  /**
   * Where somebody is, and where they are from: "Liverpool · From Somalia".
   *
   * The two things a member weighs before answering a stranger, and the two the card shows anyway —
   * so a notification that names neither makes them open the app to learn what the row could have
   * told them. Each half is dropped when it is not known, and `OTHER` is a member who would rather
   * not say, which is an answer rather than a gap.
   */
  async actorPlace(userId: string): Promise<string | null> {
    const actor = await this.database.user.findUnique({
      where: { id: userId },
      select: {
        isAnonymised: true,
        profile: { select: { countryOfOrigin: true, city: { select: { name: true } } } },
      },
    });

    if (!actor || actor.isAnonymised) return null;

    const country = countryNameOf(actor.profile?.countryOfOrigin);

    return (
      [actor.profile?.city?.name, country ? `From ${country}` : null].filter(Boolean).join(' · ') ||
      null
    );
  }

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

  /** Folds into an existing unread row when asked, and returns the title that should be pushed. */
  private async write(input: RaiseNotificationInput): Promise<PushableNotification | null> {
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
            metadata: toJsonOrUndefined({
              ...input.metadata,
              ...(input.target ? { target: input.target } : {}),
              collapseKey: input.collapseKey,
              count,
            }),
          },
        });

        return { ...input, title, notificationId: existing.id };
      }
    }

    const created = await this.database.notification.create({
      data: {
        userId: input.userId,
        kind: input.kind,
        categoryCode: input.categoryCode,
        title: input.title,
        body: input.body ?? null,
        route: input.route ?? null,
        actorId: input.actorId ?? null,
        metadata: toJsonOrUndefined({
          ...input.metadata,
          ...(input.target ? { target: input.target } : {}),
          ...(input.collapseKey ? { collapseKey: input.collapseKey, count: 1 } : {}),
        }),
      },
    });

    return { ...input, notificationId: created.id };
  }

  /** Fire-and-forget, like the row itself: a push that fails must never fail what raised it. */
  private async push(input: PushableNotification): Promise<void> {
    try {
      // The category's own row of the matrix (6.1.4), not a switch of its own.
      if (!(await this.preferences.allows(input.userId, input.categoryCode, 'push'))) return;

      // Every handset, not the most recent: it was a column, and a second device unsubscribed the first.
      const devices = await this.database.pushDevice.findMany({
        where: { userId: input.userId },
        select: { token: true },
        orderBy: { lastSeenAt: 'desc' },
      });

      if (!devices.length) return;

      const counts = await this.badges.of(input.userId);
      const { deadTokens } = await this.fcm.sendPushToMany(
        devices.map(device => device.token),
        input.title,
        input.body ?? '',
        {
          // Anything other than MESSAGE refreshes the notification badge, so the kind travels as-is.
          type: input.kind,
          // An in-app path or nothing. A null route is a row that marks itself read and goes nowhere.
          ...(input.route ? { route: input.route } : {}),
          // So a tap from a cold start routes without fetching the list first.
          ...(input.target ? { targetType: input.target.type, targetId: input.target.id } : {}),
          // The parent too, or a group post push is unopenable: nothing resolves a post to its group.
          ...(input.target?.parent
            ? {
                targetParentType: input.target.parent.type,
                targetParentId: input.target.parent.id,
              }
            : {}),
          notificationId: input.notificationId,
          // One number for the icon, both halves named, so either counter updates without a fetch.
          badge: String(counts.total),
          unreadNotifications: String(counts.notifications),
          unreadMessages: String(counts.messages),
        },
      );

      await this.forget(deadTokens);
    } catch (error) {
      this.logger.warn(`Notification push failed: ${(error as Error).message}`);
    }
  }

  /** Drops dead tokens by token, so one device's failure does not unsubscribe the others. */
  private async forget(tokens: string[]): Promise<void> {
    if (!tokens.length) return;

    const { count } = await this.database.pushDevice.deleteMany({
      where: { token: { in: tokens } },
    });

    if (count) this.logger.log(`Dropped ${count} dead push device(s)`);
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
        // The structured companion to `route`. Null on a row that goes nowhere, such as an
        // announcement or a declined join request.
        target: targetOf(row.metadata),
        // How many actions this row folded together: 1 unless it collapsed (6.1.2). The title
        // already says it in words; this is for a client that would rather draw it.
        count: countOf(row.metadata),
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

/** Tolerates rows written before `target` existed. */
const targetOf = (metadata: unknown): NotificationTarget | null => {
  const target = (metadata as { target?: NotificationTarget } | null)?.target;

  if (!target?.type || !target?.id) return null;

  return {
    type: target.type,
    id: target.id,
    ...(target.parent?.type && target.parent?.id ? { parent: target.parent } : {}),
  };
};

const countOf = (metadata: unknown): number => (metadata as { count?: number } | null)?.count ?? 1;
