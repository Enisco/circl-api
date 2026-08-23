import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/infrastructure';

/**
 * Blocking is one list across the whole app (1.0.4, 1.8.2).
 *
 * It is symmetric in effect: neither party sees the other's content in feeds,
 * lists or search, and neither can message the other. It is deliberately NOT
 * symmetric in storage — who blocked whom matters for the unblock action and for
 * moderation.
 *
 * Content already on screen is returned with `viewer.isBlocked = true` rather
 * than removed, so the unblock action stays reachable (1.2.2). Hiding it
 * server-side makes offering that action impossible.
 */
@Injectable()
export class BlockingService {
  constructor(private readonly database: PrismaService) {}

  /** Every user id this viewer must not see in a list, in either direction. */
  async blockedUserIds(viewerId: string | null): Promise<string[]> {
    if (!viewerId) return [];

    const blocks = await this.database.block.findMany({
      where: { OR: [{ blockerId: viewerId }, { blockedId: viewerId }] },
      select: { blockerId: true, blockedId: true },
    });

    const ids = new Set<string>();

    for (const block of blocks) {
      ids.add(block.blockerId === viewerId ? block.blockedId : block.blockerId);
    }

    return [...ids];
  }

  /** True when either party has blocked the other. */
  async isBlockedEitherWay(userA: string | null, userB: string | null): Promise<boolean> {
    if (!userA || !userB || userA === userB) return false;

    const block = await this.database.block.findFirst({
      where: {
        OR: [
          { blockerId: userA, blockedId: userB },
          { blockerId: userB, blockedId: userA },
        ],
      },
      select: { blockerId: true },
    });

    return block !== null;
  }

  /**
   * A Prisma `where` fragment excluding blocked authors from a list.
   *
   * Returns undefined when there is nothing to exclude, so callers can spread it
   * without adding an empty `notIn` to every query.
   */
  buildExclusion(blockedIds: string[], authorField = 'authorId') {
    if (!blockedIds.length) return undefined;

    return { [authorField]: { notIn: blockedIds } };
  }
}
