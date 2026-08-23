import { Injectable } from '@nestjs/common';
import {
  GuardThreadState,
  ModerationQueueType,
  ReportTargetType,
  RiskLevel,
  SystemMessageType,
  TaxonomyKind,
  ThreadContextType,
  ThreadKind,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiException, buildPageMeta, toJson } from '@/common';
import { RiskScannerService, TaxonomyService } from '../../shared';
import { ConversationFactoryService } from '../../messaging/services/conversation-factory.service';
import { MessageService } from '../../messaging/services/message.service';
import { CreateGuardThreadDto, ListGuardThreadsDto } from '../dtos/guard.dto';

/**
 * Circl Guard: the private admin channel.
 *
 * "Direct-to-admin messaging, invisible to the community. For sensitive
 * situations members don't want to post publicly."
 *
 * Two things this deliberately does NOT do:
 *
 * It makes no response-time promise (1.9). Support is being handled separately
 * from this build, so the opening system message states what the channel is and
 * who can see it, and commits to no timeframe. There is no `expectedByAt` on the
 * record. When Guard's operations are defined, the promise and the field arrive
 * together — not before.
 *
 * It never creates a public post. A member who chose private and later finds
 * their question in the feed has been badly failed, so this path shares nothing
 * with the community request tables.
 */
@Injectable()
export class GuardService {
  constructor(
    private readonly database: PrismaService,
    private readonly conversations: ConversationFactoryService,
    private readonly messages: MessageService,
    private readonly risk: RiskScannerService,
    private readonly taxonomy: TaxonomyService,
  ) {}

  async createThread(userId: string, dto: CreateGuardThreadDto) {
    if (dto.categoryCode) {
      await this.taxonomy.assertValid(
        TaxonomyKind.COMMUNITY_CATEGORY,
        dto.categoryCode,
        'categoryCode',
      );
    }

    // The scan decides where this lands in the admin queue and how loudly, which
    // is the whole point of the risk-aware queue: a member in danger should not
    // be sitting behind a queue of spam reports.
    const assessment = await this.risk.scan(dto.subject, dto.message);
    const staffIds = await this.conversations.staffUserIds();

    const result = await this.database.$transaction(async tx => {
      const { conversation } = await this.conversations.ensure(
        {
          kind: ThreadKind.SUPPORT,
          participantIds: [userId],
          staffIds,
          contextType: ThreadContextType.SUPPORT,
          contextId: null,
          snapshot: { title: 'Circl team', subtitle: dto.subject },
          // Pinned so it is first for everyone. Somebody who needed this channel
          // should not have to scroll to find the reply.
          isPinned: true,
        },
        tx,
      );

      const thread = await tx.guardThread.create({
        data: {
          userId,
          subject: dto.subject,
          categoryCode: dto.categoryCode ?? null,
          conversationId: conversation.id,
          riskLevel: assessment.level,
          riskCategory: assessment.category,
          riskScore: assessment.score,
          riskSignals: toJson(assessment.signals),
        },
      });

      // States what the channel is and who can see it, and commits to no
      // timeframe (1.9).
      await this.conversations.postSystemMessage(
        conversation.id,
        SystemMessageType.SUPPORT_OPENED,
        "This is a private thread with Circl's team. Nobody in the community can see it. " +
          'Someone will read it and reply here.',
        { guardThreadId: thread.id },
        tx,
      );

      await tx.moderationQueueItem.upsert({
        where: {
          type_targetType_targetId: {
            type: ModerationQueueType.GUARD_RISK,
            targetType: ReportTargetType.CONVERSATION,
            targetId: conversation.id,
          },
        },
        update: {
          riskLevel: assessment.level,
          riskCategory: assessment.category,
          riskScore: assessment.score,
        },
        create: {
          type: ModerationQueueType.GUARD_RISK,
          targetType: ReportTargetType.CONVERSATION,
          targetId: conversation.id,
          subjectUserId: userId,
          riskLevel: assessment.level,
          riskCategory: assessment.category,
          // A private-to-Circl thread always reaches a human, so it carries a
          // baseline score even when no risk phrase matched — somebody chose this
          // channel over a public post, and that is itself a signal.
          riskScore: Math.max(assessment.score, 15),
          riskSignals: toJson(assessment.signals),
          summary: dto.subject,
        },
      });

      return { thread, conversationId: conversation.id };
    });

    // The member's own words go in as their first message, so the thread reads as
    // a conversation rather than a form submission.
    await this.messages.send(userId, result.conversationId, {
      clientId: `guard-${result.thread.id}`,
      body: dto.message,
    });

    return {
      id: result.thread.id,
      subject: result.thread.subject,
      state: result.thread.state,
      conversationId: result.conversationId,
      createdAt: result.thread.createdAt.toISOString(),
    };
  }

  async listMine(userId: string, query: ListGuardThreadsDto) {
    const where = { userId };

    const [total, rows] = await this.database.$transaction([
      this.database.guardThread.count({ where }),
      this.database.guardThread.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
      }),
    ]);

    return {
      data: rows.map(row => ({
        id: row.id,
        subject: row.subject,
        state: row.state,
        conversationId: row.conversationId,
        createdAt: row.createdAt.toISOString(),
        // Deliberately absent: riskLevel, riskCategory and riskScore. Those are
        // for the admin queue, and telling a member the algorithm scored their
        // situation would be both alarming and useless to them.
      })),
      meta: buildPageMeta(query, total),
    };
  }

  async findMine(userId: string, id: string) {
    const thread = await this.database.guardThread.findUnique({ where: { id } });

    if (!thread || thread.userId !== userId) {
      throw ApiException.notFound('That thread could not be found.');
    }

    return {
      id: thread.id,
      subject: thread.subject,
      state: thread.state,
      conversationId: thread.conversationId,
      createdAt: thread.createdAt.toISOString(),
    };
  }

  /**
   * Guard also scans private admin messages, not just the opening one (the Guard
   * description names both). Called from the message path for support threads.
   */
  async rescoreFromMessage(conversationId: string, body: string): Promise<void> {
    const thread = await this.database.guardThread.findUnique({ where: { conversationId } });

    if (!thread) return;

    const assessment = await this.risk.scan(body);

    if (assessment.level === RiskLevel.NONE) return;

    // Scores accumulate across a thread: a situation that escalates over several
    // messages should climb the queue, not sit at whatever the first line scored.
    await this.database.$transaction([
      this.database.guardThread.update({
        where: { id: thread.id },
        data: {
          riskScore: { increment: assessment.score },
          ...(assessment.score > thread.riskScore
            ? { riskLevel: assessment.level, riskCategory: assessment.category }
            : {}),
          state: GuardThreadState.OPEN,
        },
      }),
      this.database.moderationQueueItem.updateMany({
        where: { targetType: ReportTargetType.CONVERSATION, targetId: conversationId },
        data: { riskScore: { increment: assessment.score } },
      }),
    ]);
  }
}
