import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/infrastructure';

/** Blocking is one list across the whole app (1.0.4, 1.8.2). */
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

  /** A Prisma `where` fragment excluding blocked authors from a list. */
  buildExclusion(blockedIds: string[], authorField = 'authorId') {
    if (!blockedIds.length) return undefined;

    return { [authorField]: { notIn: blockedIds } };
  }
}
