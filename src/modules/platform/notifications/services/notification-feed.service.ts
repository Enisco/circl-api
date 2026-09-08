import { Injectable, Logger } from '@nestjs/common';
import { NotificationBucket, NotificationKind, Prisma } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { buildPageMeta, toJsonOrUndefined } from '@/common';
import {
  authorSelect,
  BadgeService,
  displayNameOf,
  MediaService,
  toAuthorView,
} from '../../shared';
import { FcmService } from '@/modules/infrastructure/notification/providers/push/fcm.service';
import { ListNotificationsDto } from '../dtos';
import { NotificationPreferenceService } from './notification-preference.service';

/**
 * What the notification is *about*, structured, so the client can route natively instead of
 * parsing `route` as a string.
 *
 * `route` stays the authority — it is server-owned precisely so a new kind is tappable without an
 * app release (6.1.1) — and this is the companion for a client that would rather push a typed
 * screen than a path. Both always point at the same thing.
 */
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
  | 'PROFILE'
  | 'VERIFICATION';

export interface NotificationTarget {
  type: NotificationTargetType;
  id: string;
  /**
   * The thing the target lives inside, when it cannot be opened without it. A group post is the
   * case that forced this: the screen that shows its replies is
   * `/community/groups/{groupId}/posts/{postId}/replies`, so a post id alone names something the
   * client cannot fetch, and there is no endpoint that resolves a post to its group.
   *
   * Set it only where it is genuinely needed. A request, a guide and an order are all openable
   * from their own id, and inventing a parent for them would be noise.
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
  /**
   * The thing the notification is about. Set it wherever there is one: it is what lets the client
   * open a screen without reverse-engineering a URL, and leaving it to each caller's `metadata` is
   * how the two drifted apart in the first place.
   */
  target?: NotificationTarget | null;
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
    private readonly badges: BadgeService,
  ) {}

  /**
   * The actor's name, for a title that reads "Ada liked your guide" rather than "Somebody did".
   * Here rather than in each section because five of them now need the same two lines, and a
   * deleted or anonymised member has to fall back to the same word in all five.
   */
  async actorName(userId: string): Promise<string> {
    const actor = await this.database.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true, isAnonymised: true },
    });

    if (!actor || actor.isAnonymised) return 'Someone';

    return displayNameOf(actor.firstName, actor.lastName) || 'Someone';
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

  /**
   * Writes the row, folding into an existing unread one where the caller asked for collapsing.
   * Returns what should be pushed, which for a collapsed row is the updated title rather than the
   * original, so the phone says "3 people liked your post" rather than buzzing three times with
   * the same sentence.
   */
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

      // Every handset they are signed in on, not the most recent one. A member reading on a
      // tablet and carrying a phone should be reachable on both, and until this was a table it
      // was a column: the second device to register silently unsubscribed the first.
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
          // The same target the list carries, so a tap from a cold start opens the right screen
          // without fetching the list first to find out where it goes.
          ...(input.target ? { targetType: input.target.type, targetId: input.target.id } : {}),
          // The parent travels too, or a group post push is unopenable for exactly the reason the
          // list row was: replies live under the group and nothing resolves a post to its group.
          ...(input.target?.parent
            ? {
                targetParentType: input.target.parent.type,
                targetParentId: input.target.parent.id,
              }
            : {}),
          notificationId: input.notificationId,
          // One number for the icon, and both halves named, so the client can update either
          // in-app counter without a fetch. `badge` used to mean two different things depending
          // on which kind of push arrived last.
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

  /**
   * Drops tokens FCM has told us are dead. Without this a member who reinstalls leaves a token
   * behind that fails on every notification forever: an error line per like, and a device that
   * quietly receives nothing with nothing in the data saying why.
   *
   * Deleted by token rather than by member, so the phone that just registered is untouched by a
   * tablet's failure.
   */
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

/** Reads the target back out of the stored metadata, tolerating rows written before it existed. */
const targetOf = (metadata: unknown): NotificationTarget | null => {
  const target = (metadata as { target?: NotificationTarget } | null)?.target;

  if (!target?.type || !target?.id) return null;

  return {
    type: target.type,
    id: target.id,
    ...(target.parent?.type && target.parent?.id ? { parent: target.parent } : {}),
  };
};

const countOf = (metadata: unknown): number =>
  (metadata as { count?: number } | null)?.count ?? 1;
