import { Injectable } from '@nestjs/common';
import { Prisma, ThreadContextType } from '@prisma/client';
import { PrismaService } from '@/infrastructure';

export interface ThreadWork {
  awaitingReply: number;
  openThreads: number;
  done: number;
}

/**
 * The three numbers a seller or a professional sees above their pipeline, counted over every thread
 * rather than over a page: showing "2 waiting" to somebody with nine is a lie the screen tells
 * confidently.
 *
 * One implementation, because `professionals/home.myWork` and `GET /deals/work` show the same three
 * numbers and two implementations would eventually disagree about one of them.
 */
@Injectable()
export class ThreadWorkService {
  constructor(private readonly database: PrismaService) {}

  async of(
    userId: string,
    subjects: Array<{ type: ThreadContextType; ids: string[] }>,
  ): Promise<ThreadWork> {
    const clauses: Prisma.ConversationWhereInput[] = subjects
      .filter(subject => subject.ids.length)
      .map(subject => ({ contextType: subject.type, contextId: { in: subject.ids } }));

    if (!clauses.length) return { awaitingReply: 0, openThreads: 0, done: 0 };

    const rows = await this.database.conversationParticipant.findMany({
      where: { userId, conversation: { OR: clauses } },
      select: {
        unreadCount: true,
        isArchived: true,
        conversation: {
          select: {
            messages: {
              where: { deletedAt: null },
              orderBy: { sentAt: 'desc' },
              take: 1,
              select: { senderId: true },
            },
          },
        },
      },
    });

    const open = rows.filter(row => !row.isArchived);

    return {
      // Unread, or the last word was theirs: either way the next move is this member's.
      awaitingReply: open.filter(
        row => row.unreadCount > 0 || (row.conversation.messages[0]?.senderId ?? userId) !== userId,
      ).length,
      // "Open" can only mean not archived: nothing else finishes an enquiry.
      openThreads: open.length,
      done: rows.length - open.length,
    };
  }
}
