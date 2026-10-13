import { Injectable } from '@nestjs/common';
import {
  GuardCaseSource,
  GuardThreadState,
  ModerationQueueState,
  ModerationQueueType,
  ReportTargetType,
  RiskLevel,
  SystemMessageType,
  SupportThreadType,
  TaxonomyKind,
  ThreadContextType,
  ThreadKind,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiException, buildPageMeta, toJson } from '@/common';
import {
  MediaRules,
  MediaService,
  QueueDeadlineService,
  RiskScannerService,
  TaxonomyService,
} from '../../shared';
import { ConversationFactoryService } from '../../messaging/services/conversation-factory.service';
import { MessageService } from '../../messaging/services/message.service';
import {
  CreateGuardRequestDto,
  CreateGuardThreadDto,
  ListGuardThreadsDto,
} from '../dtos/guard.dto';

/** Photos only, and few of them: this is evidence, not a gallery (6.3.1). */
const GUARD_MEDIA_RULES: MediaRules = { maxImages: 5, allowVideo: false, allowAudio: false };

const GUARD_MEDIA_OWNER = 'GUARD_THREAD';

/**
 * The floor for a staff-raised case, in both the band and the score.
 *
 * A scan of a one-line subject finds nothing, so an escalation would otherwise open at NONE and
 * sort below every piece of spam in the queue — which is the opposite of what escalating means.
 */
const MIN_ESCALATED_SCORE = 40;

const raise = (level: RiskLevel): RiskLevel =>
  level === RiskLevel.NONE || level === RiskLevel.LOW ? RiskLevel.MEDIUM : level;

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
    private readonly deadlines: QueueDeadlineService,
  ) {}

  async createThread(userId: string, dto: CreateGuardThreadDto) {
    if (dto.categoryCode) {
      // GUARD_CATEGORY, not COMMUNITY_CATEGORY (B28). The DTO documents these codes as
      // `HOUSING, IMMIGRATION, SAFETY, MONEY, HEALTH, WORK, OTHER` and `createRequest` validates
      // against that kind — this path checked the community categories instead, so every code the
      // app actually sends was rejected, and the community codes it would have accepted are not
      // codes the admin portal can label.
      await this.taxonomy.assertValid(
        TaxonomyKind.GUARD_CATEGORY,
        dto.categoryCode,
        'categoryCode',
      );
    }

    // The scan decides where this lands in the admin queue and how loudly, which is the whole point of the risk-aware queue: a member in danger should not be sitting behind a queue of spam reports.
    const assessment = await this.risk.scan(dto.subject, dto.message);

    const result = await this.database.$transaction(async tx => {
      const { conversation } = await this.conversations.ensure(
        {
          kind: ThreadKind.SUPPORT,
          // Said rather than derived. A Guard disclosure and a deal problem share one
          // conversation key (D36), so nothing about the context distinguishes them — and a
          // disclosure typed anything else is listed in the support inbox to the whole team
          // (§5.15). `settledType` makes this stick even if a deal problem claims the thread
          // afterwards.
          supportType: SupportThreadType.GUARD,
          participantIds: [userId],
          contextType: ThreadContextType.SUPPORT,
          contextId: null,
          snapshot: { title: 'Circl team', subtitle: dto.subject },
          // Pinned so it is first for everyone.
          isPinned: true,
        },
        tx,
      );

      // The member's **second** disclosure continues the first (D36): `ensure` returns the
      // conversation they already have, and `GuardThread.conversationId` is unique — so creating
      // a row here unconditionally was a 500 on the second use of the "tell Circl privately"
      // button. On a safeguarding channel that is the worst possible failure: somebody who has
      // already decided to tell us something concludes nobody wants to hear it.
      //
      // The queue item below has always been an `upsert` on the same key, so the reuse was known
      // about; this row was the half that was missed. `openForStaff` resolves it the same way.
      const existing = await tx.guardThread.findFirst({
        where: { conversationId: conversation.id },
        orderBy: { createdAt: 'asc' },
      });
      const thread = existing
        ? await tx.guardThread.update({
            where: { id: existing.id },
            data: {
              // Back in front of a human. Somebody writing again about something marked resolved
              // is saying it is not resolved.
              state: GuardThreadState.OPEN,
              subject: dto.subject,
              ...(dto.categoryCode ? { categoryCode: dto.categoryCode } : {}),
              // Raise only, like every other risk score on the platform: a calmer second message
              // does not make the first one less serious.
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
              subject: dto.subject,
              categoryCode: dto.categoryCode ?? null,
              conversationId: conversation.id,
              riskLevel: assessment.level,
              riskCategory: assessment.category,
              riskScore: assessment.score,
              riskSignals: toJson(assessment.signals),
            },
          });

      // States what the channel is and who can see it, and commits to no timeframe (1.9). Only
      // once: a member who is already in the thread does not need telling what it is again.
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

      // Urgent on the wall clock: a safeguarding thread is an hour at three in the morning as
      // much as at three in the afternoon.
      const stamp = await this.deadlines.stamp({
        type: ModerationQueueType.GUARD_RISK,
        riskLevel: assessment.level,
      });

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
          ...stamp,
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

    const result = await this.database.$transaction(async tx => {
      const { conversation } = await this.conversations.ensure(
        {
          kind: ThreadKind.SUPPORT,
          // Said rather than derived. A Guard disclosure and a deal problem share one
          // conversation key (D36), so nothing about the context distinguishes them — and a
          // disclosure typed anything else is listed in the support inbox to the whole team
          // (§5.15). `settledType` makes this stick even if a deal problem claims the thread
          // afterwards.
          supportType: SupportThreadType.GUARD,
          participantIds: [userId],
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

      // Urgent on the wall clock: a safeguarding thread is an hour at three in the morning as
      // much as at three in the afternoon.
      const stamp = await this.deadlines.stamp({
        type: ModerationQueueType.GUARD_RISK,
        riskLevel: assessment.level,
      });

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
          ...stamp,
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

  /**
   * Open a Guard case because staff decided to, rather than because a member asked (§5.12).
   *
   * Lives here, with the two member paths, because D36's rule is that a member has **one** private
   * thread with the team: a second one is a safeguarding conversation split in half, where each
   * half reads as the whole story. `createRequest` already implements that reuse, and a copy of
   * the transaction in the admin service would be the second place for it to drift.
   *
   * Differences from a member opening one, all of them deliberate:
   *  - the first message is not sent. Staff write their own opening line in the thread, and a
   *    system-authored "we are looking into this" would be a promise nobody made.
   *  - the floor is MEDIUM. Somebody looked at something and decided it needed safeguarding, so
   *    the case does not sit below the band that gets worked — a scan that scored it NONE is
   *    exactly the scan the escalation disagrees with.
   *  - `sourceType` records who raised it, which the row cannot otherwise tell afterwards.
   */
  async openForStaff(input: {
    memberId: string;
    subject: string;
    categoryCode?: string | null;
    sourceType: GuardCaseSource;
    sourceId: string | null;
    riskLevel?: RiskLevel | null;
  }) {
    const category = input.categoryCode
      ? await this.taxonomy.assertValid(
          TaxonomyKind.GUARD_CATEGORY,
          input.categoryCode,
          'categoryCode',
        )
      : null;

    // Scanned for the signals, so a reviewer sees why it scored what it did, but the level is
    // floored below.
    const assessment = await this.risk.scan(input.subject, '');
    const level = input.riskLevel ?? raise(assessment.level);
    const score = Math.max(assessment.score, MIN_ESCALATED_SCORE);

    return this.database.$transaction(async tx => {
      const { conversation } = await this.conversations.ensure(
        {
          kind: ThreadKind.SUPPORT,
          // Said rather than derived. A Guard disclosure and a deal problem share one
          // conversation key (D36), so nothing about the context distinguishes them — and a
          // disclosure typed anything else is listed in the support inbox to the whole team
          // (§5.15). `settledType` makes this stick even if a deal problem claims the thread
          // afterwards.
          supportType: SupportThreadType.GUARD,
          participantIds: [input.memberId],
          contextType: ThreadContextType.SUPPORT,
          contextId: null,
          snapshot: { title: 'Circl team', subtitle: input.subject },
          isPinned: true,
        },
        tx,
      );

      const existing = await tx.guardThread.findFirst({
        where: { userId: input.memberId, conversationId: conversation.id },
        orderBy: { createdAt: 'asc' },
      });

      const thread = existing
        ? await tx.guardThread.update({
            where: { id: existing.id },
            data: {
              // Back in front of a human: staff escalating onto a resolved thread are saying it
              // is not resolved.
              state: GuardThreadState.OPEN,
              ...(category ? { categoryCode: category.code } : {}),
              riskScore: Math.max(existing.riskScore, score),
              ...(score > existing.riskScore
                ? { riskLevel: level, riskCategory: assessment.category }
                : {}),
              // The source is overwritten on purpose: the most recent reason a case is open is
              // the one staff are working, and the history of how it got here is the audit log's
              // job rather than this column's.
              sourceType: input.sourceType,
              sourceId: input.sourceId,
            },
          })
        : await tx.guardThread.create({
            data: {
              userId: input.memberId,
              subject: input.subject,
              categoryCode: category?.code ?? null,
              conversationId: conversation.id,
              riskLevel: level,
              riskCategory: assessment.category,
              riskScore: score,
              riskSignals: toJson(assessment.signals),
              sourceType: input.sourceType,
              sourceId: input.sourceId,
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

      const stamp = await this.deadlines.stamp({
        type: ModerationQueueType.GUARD_RISK,
        riskLevel: level,
      });

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
          riskLevel: level,
          riskCategory: assessment.category,
          riskScore: score,
        },
        create: {
          type: ModerationQueueType.GUARD_RISK,
          targetType: ReportTargetType.CONVERSATION,
          targetId: conversation.id,
          subjectUserId: input.memberId,
          ...stamp,
          riskLevel: level,
          riskCategory: assessment.category,
          riskScore: score,
          riskSignals: toJson(assessment.signals),
          summary: input.subject,
        },
      });

      return { thread, conversationId: conversation.id, reopened: Boolean(existing) };
    });
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

  /**
   * Scoring a Guard thread from its later messages lives in `MessageSafetyService` (§6.8), with
   * the scan job that is the only thing that triggers it. It used to live here as
   * `rescoreFromMessage`, which nothing called.
   */
}
