import { Injectable } from '@nestjs/common';
import {
  GuardThreadState,
  ModerationQueueState,
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
import { MediaRules, MediaService, RiskScannerService, TaxonomyService } from '../../shared';
import { ConversationFactoryService } from '../../messaging/services/conversation-factory.service';
import { MessageService } from '../../messaging/services/message.service';
import { CreateGuardRequestDto, CreateGuardThreadDto, ListGuardThreadsDto } from '../dtos/guard.dto';

/** Photos only, and few of them: this is evidence, not a gallery (6.3.1). */
const GUARD_MEDIA_RULES: MediaRules = { maxImages: 5, allowVideo: false, allowAudio: false };

const GUARD_MEDIA_OWNER = 'GUARD_THREAD';

/** Circl Guard: the private admin channel. */
@Injectable()
export class GuardService {
  constructor(
    private readonly database: PrismaService,
    private readonly conversations: ConversationFactoryService,
    private readonly messages: MessageService,
    private readonly risk: RiskScannerService,
    private readonly taxonomy: TaxonomyService,
    private readonly media: MediaService,
  ) {}

  async createThread(userId: string, dto: CreateGuardThreadDto) {
    if (dto.categoryCode) {
      await this.taxonomy.assertValid(
        TaxonomyKind.COMMUNITY_CATEGORY,
        dto.categoryCode,
        'categoryCode',
      );
    }

    // The scan decides where this lands in the admin queue and how loudly, which is the whole point of the risk-aware queue: a member in danger should not be sitting behind a queue of spam reports.
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
          // Pinned so it is first for everyone.
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

      // States what the channel is and who can see it, and commits to no timeframe (1.9).
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
          // A private-to-Circl thread always reaches a human, so it carries a baseline score even when no risk phrase matched — somebody chose this channel over a public post, and that is itself a signal.
          riskScore: Math.max(assessment.score, 15),
          riskSignals: toJson(assessment.signals),
          summary: dto.subject,
        },
      });

      return { thread, conversationId: conversation.id };
    });

    // The member's own words go in as their first message, so the thread reads as a conversation rather than a form submission.
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

  /** A private request to Circl (6.3.1). */
  async createRequest(userId: string, dto: CreateGuardRequestDto) {
    const category = await this.taxonomy.assertValid(
      TaxonomyKind.GUARD_CATEGORY,
      dto.categoryCode,
      'categoryCode',
    );

    const media = await this.media.validate(dto.mediaKeys, userId, GUARD_MEDIA_RULES, 'mediaKeys');

    const assessment = await this.risk.scan(category.label, dto.body);
    const staffIds = await this.conversations.staffUserIds();

    const result = await this.database.$transaction(async tx => {
      const { conversation } = await this.conversations.ensure(
        {
          kind: ThreadKind.SUPPORT,
          participantIds: [userId],
          staffIds,
          contextType: ThreadContextType.SUPPORT,
          contextId: null,
          snapshot: { title: 'Circl team', subtitle: category.label },
          isPinned: true,
        },
        tx,
      );

      const existing = await tx.guardThread.findFirst({
        where: { userId, conversationId: conversation.id },
        orderBy: { createdAt: 'asc' },
      });

      const thread = existing
        ? await tx.guardThread.update({
            where: { id: existing.id },
            data: {
              // A reopened thread goes back in front of a human.
              state: GuardThreadState.OPEN,
              categoryCode: category.code,
              // The risk of the thread is the worst it has ever been, not the worst of the latest message.
              riskScore: Math.max(existing.riskScore, assessment.score),
              ...(assessment.score > existing.riskScore
                ? {
                    riskLevel: assessment.level,
                    riskCategory: assessment.category,
                    riskSignals: toJson(assessment.signals),
                  }
                : {}),
            },
          })
        : await tx.guardThread.create({
            data: {
              userId,
              subject: category.label,
              categoryCode: category.code,
              conversationId: conversation.id,
              riskLevel: assessment.level,
              riskCategory: assessment.category,
              riskScore: assessment.score,
              riskSignals: toJson(assessment.signals),
            },
          });

      if (!existing) {
        await this.conversations.postSystemMessage(
          conversation.id,
          SystemMessageType.SUPPORT_OPENED,
          "This is a private thread with Circl's team. Nobody in the community can see it. " +
            'Someone will read it and reply here.',
          { guardThreadId: thread.id },
          tx,
        );
      }

      await tx.moderationQueueItem.upsert({
        where: {
          type_targetType_targetId: {
            type: ModerationQueueType.GUARD_RISK,
            targetType: ReportTargetType.CONVERSATION,
            targetId: conversation.id,
          },
        },
        update: {
          state: ModerationQueueState.PENDING,
          riskLevel: assessment.level,
          riskCategory: assessment.category,
          riskScore: Math.max(assessment.score, 15),
        },
        create: {
          type: ModerationQueueType.GUARD_RISK,
          targetType: ReportTargetType.CONVERSATION,
          targetId: conversation.id,
          subjectUserId: userId,
          riskLevel: assessment.level,
          riskCategory: assessment.category,
          riskScore: Math.max(assessment.score, 15),
          riskSignals: toJson(assessment.signals),
          summary: category.label,
        },
      });

      if (media.length) await this.media.attach(tx, media, GUARD_MEDIA_OWNER, thread.id);

      return { thread, conversationId: conversation.id };
    });

    await this.messages.send(userId, result.conversationId, {
      clientId: `guard-request-${result.thread.id}-${Date.now()}`,
      body: dto.body,
    });

    return { data: { conversationId: result.conversationId } };
  }

  /** The crisis and advice lines the app lists (6.3.3). */
  async resources(countryCode: string) {
    const rows = await this.database.supportResource.findMany({
      where: { countryCode: countryCode.toUpperCase(), isActive: true },
      // Crisis rows first, above the "Other places that can help" heading.
      orderBy: [{ isCrisis: 'desc' }, { sort: 'asc' }, { name: 'asc' }],
    });

    const lastCheckedAt = rows.reduce<Date | null>(
      (oldest, row) => (!oldest || row.lastCheckedAt < oldest ? row.lastCheckedAt : oldest),
      null,
    );

    return {
      data: rows.map(row => ({
        name: row.name,
        phone: row.phone,
        // `number` and `description` are the names the app's sheet reads; `phone` and `hours` are
        // the spec's. Both are sent rather than renaming one side out from under the other.
        number: row.phone,
        description: row.description,
        url: row.url,
        isCrisis: row.isCrisis,
        hours: row.hours,
      })),
      meta: {
        // The ISO date beside the display string, so a client that wants to compare it can.
        lastChecked: lastCheckedAt ? lastCheckedAt.toISOString().slice(0, 10) : null,
        // A display string, and the one place 0.6's no-preformatted-dates rule is relaxed: the client renders it under the list and never compares it.
        lastCheckedAt: lastCheckedAt
          ? lastCheckedAt.toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })
          : null,
      },
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
        // Deliberately absent: riskLevel, riskCategory and riskScore.
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

  /** Guard also scans private admin messages, not just the opening one (the Guard description names both). */
  async rescoreFromMessage(conversationId: string, body: string): Promise<void> {
    const thread = await this.database.guardThread.findUnique({ where: { conversationId } });

    if (!thread) return;

    const assessment = await this.risk.scan(body);

    if (assessment.level === RiskLevel.NONE) return;

    // Scores accumulate across a thread: a situation that escalates over several messages should climb the queue, not sit at whatever the first line scored.
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
