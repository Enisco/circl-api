import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/infrastructure';
import { BlockingService } from '../../shared';
import { PresenceRegistry } from './presence.registry';

export interface PresenceView {
  userId: string;
  isOnline: boolean;
  /** When they were last seen, whether or not they are online now. Null if never. */
  lastSeenAt: string | null;
}

/**
 * Online means a live socket and nothing softer: a wrong green dot reads as "they are ignoring me".
 * `lastSeenAt` is the soft signal, kept separate — the newest `lastActiveAt` across their sessions.
 */
@Injectable()
export class PresenceService {
  constructor(
    private readonly database: PrismaService,
    private readonly registry: PresenceRegistry,
    private readonly blocking: BlockingService,
  ) {}

  async of(viewerId: string, userIds: string[]): Promise<PresenceView[]> {
    const wanted = [...new Set(userIds)].filter(Boolean);

    if (!wanted.length) return [];

    // Blocked in either direction reads as offline with no last seen, the same as somebody who has
    // never signed in. It is not an error: the caller has no business knowing which it is.
    const blocked = new Set(await this.blocking.blockedUserIds(viewerId));
    const visible = wanted.filter(userId => !blocked.has(userId));

    const [members, sessions] = await Promise.all([
      this.database.user.findMany({
        where: { id: { in: visible }, deletedAt: null, isAnonymised: false },
        select: { id: true },
      }),
      // One row per member: the most recent activity across all their sessions.
      this.database.userSession.groupBy({
        by: ['userId'],
        where: { userId: { in: visible } },
        _max: { lastActiveAt: true },
      }),
    ]);

    const known = new Set(members.map(member => member.id));
    const lastSeen = new Map(
      sessions.map(row => [row.userId, row._max.lastActiveAt?.toISOString() ?? null]),
    );
    const online = this.registry.onlineAmong([...known]);

    // Every id asked about comes back, in the order it was asked, so the client can zip the result
    // against its own list without matching on ids.
    return wanted.map(userId => ({
      userId,
      isOnline: online.has(userId),
      lastSeenAt: known.has(userId) ? (lastSeen.get(userId) ?? null) : null,
    }));
  }

  /** The single-member case, for a profile screen. */
  async one(viewerId: string, userId: string): Promise<PresenceView> {
    const [view] = await this.of(viewerId, [userId]);

    return view;
  }
}
