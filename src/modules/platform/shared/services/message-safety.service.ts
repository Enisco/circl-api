import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  ContentRiskTier,
  ContentScanTrigger,
  GuardThreadState,
  ModerationQueueState,
  ModerationQueueType,
  ReportTargetType,
  RiskCategory,
  RiskLevel,
  ThreadKind,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { SYSTEM_CONFIG_KEYS, excerpt, rowDigest, toJson } from '@/common';
import { ContentSafetyService } from './content-safety.service';
import { QueueDeadlineService } from './queue-deadline.service';
import {
  Escalation,
  MESSAGE_ESCALATED_ACTION,
  MESSAGE_SCAM_CATEGORIES,
  THREAT_SIGNAL_AT,
  THREAT_SIGNAL_CATEGORIES,
  escalates,
  escalationFor,
} from './message-escalation';
import { RiskScannerService } from './risk-scanner.service';
import { SafetyClassifierService } from './safety-classifier.service';
import { SystemConfigService } from './system-config.service';
import { scoreOf, tierOf } from './safety-scoring';

/** The thread kinds this job scans (§6.8.1). */
const SCANNED_KINDS: ThreadKind[] = [
  ThreadKind.DIRECT,
  ThreadKind.COMMUNITY,
  ThreadKind.PROFESSIONAL,
  ThreadKind.CONNECT,
  ThreadKind.COMMERCE,
  ThreadKind.GROUP,
];

/**
 * Private messages (§6.8).
 *
 * The one scan in the platform that **changes nothing a member can see**. The message is not
 * hidden, the thread is not interrupted, and nobody is notified in-app, by push or by email.
 * Staff decide whether and how to reach out, which is the whole design: a safeguarding signal in
 * a private conversation is a reason for a person to look, not for software to act.
 *
 * It also scans for less than the content pipeline does. Only the safeguarding categories and the
 * two commercial ones (`SCAM`, `LANDLORD_FRAUD`) do anything here; everything else a lexicon
 * might match in a private conversation between two people is none of the platform's business.
 */
@Injectable()
export class MessageSafetyService {
  private readonly logger = new Logger(MessageSafetyService.name);

  constructor(
    private readonly database: PrismaService,
    private readonly risk: RiskScannerService,
    private readonly classifier: SafetyClassifierService,
    private readonly config: SystemConfigService,
    private readonly safety: ContentSafetyService,
    private readonly deadlines: QueueDeadlineService,
  ) {}

  async scan(messageId: string): Promise<'skipped' | 'signal' | 'escalated'> {
    const message = await this.database.message.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        body: true,
        senderId: true,
        sentAt: true,
        deletedAt: true,
        conversationId: true,
        sender: { select: { id: true, isStaff: true } },
        conversation: {
          select: {
            id: true,
            kind: true,
            participants: { select: { userId: true } },
            guardThread: { select: { id: true, riskScore: true } },
          },
        },
      },
    });

    // §6.8: a message deleted before the job runs is skipped, and staff are not scanned.
    if (!message || message.deletedAt || !message.body?.trim()) return 'skipped';
    if (!message.senderId || message.sender?.isStaff) return 'skipped';

    // Before the kind check, not after it: a Guard thread is a SUPPORT conversation, so the next
    // line would walk away from every one of them and the scoring below would be unreachable.
    if (message.conversation.guardThread) {
      return this.rescoreGuardThread(message, message.conversation.guardThread);
    }

    // SUPPORT threads that are not Guard -- deal problems, support chat -- are nobody's case.
    if (!SCANNED_KINDS.includes(message.conversation.kind)) return 'skipped';

    const [thresholds, criticalCategories, settings] = await Promise.all([
      this.risk.thresholds(),
      this.risk.criticalCategories(),
      this.config.get(SYSTEM_CONFIG_KEYS.CLASSIFIER),
    ]);
    const watched = [...criticalCategories, ...MESSAGE_SCAM_CATEGORIES];
    const assessment = await this.risk.scanFields({ body: message.body });

    // Narrowed to what this job watches, and re-scored on what is left: a private message that
    // matches a hate term is not this job's business, and leaving its weight in the score would
    // escalate on a category the rules then refuse to act on.
    const signals = assessment.signals.filter(signal => watched.includes(signal.category));
    const lexiconScore = [
      ...new Map(signals.map(signal => [signal.termId, signal])).values(),
    ].reduce((total, signal) => total + signal.weight, 0);
    const lexiconCategory = heaviest(signals);
    const classified = await this.classifier.classify({ fields: { body: message.body } });
    const classifier = classified.result;

    const verdict = scoreOf({
      lexiconScore,
      lexiconCategory,
      lexiconCriticalHit: signals.some(
        signal => signal.weight >= thresholds.high && criticalCategories.includes(signal.category),
      ),
      classifier,
      thresholds,
      criticalCategories,
      weight: settings.weight,
    });

    // The classifier may have an opinion about a category this job does not watch. Its *score*
    // still counts — a confident model is evidence — but the category that decides the rules is
    // the watched one, so an unwatched classifier category falls back to the lexicon's.
    const category = watched.includes(verdict.category ?? '') ? verdict.category : lexiconCategory;

    // Nothing this job watches: neither a watched lexicon term nor a classifier opinion in a
    // watched category. A private message that matches nothing we would act on leaves no record.
    //
    // The test is the category alone, deliberately not "no category *or* no lexicon weight":
    // §6.3 blends two sources of evidence and a confident classifier is one of them, so a
    // classifier-only safeguarding hit has to reach the rules below rather than be dropped here
    // for having matched no term.
    if (!category) return 'skipped';

    await this.database.$transaction(tx =>
      this.safety.assess(tx, {
        targetType: ReportTargetType.MESSAGE,
        targetId: message.id,
        authorId: message.senderId,
        fields: { body: message.body },
        trigger: ContentScanTrigger.CREATE,
        // Evidence only. §6.8 is explicit that nothing a member sees changes.
        mode: 'OBSERVE',
        // The answer this job already has, so the row records the verdict the rules below acted
        // on. An OBSERVE scan queues no worker pass, so nothing would ever come back to fix it.
        classified,
      }),
    );

    if (verdict.finalScore < thresholds.high) return 'signal';

    const tier = tierOf(verdict.finalScore, category, thresholds, criticalCategories);

    if (escalates(category, criticalCategories)) {
      await this.escalate(message, category, tier, verdict.finalScore, classifier);

      return 'escalated';
    }

    if (MESSAGE_SCAM_CATEGORIES.includes(category)) {
      // §6.8: a scam reads as something the sender did, so the item is about them.
      await this.flag(message, 'SENDER', message.senderId, category, tier, verdict.finalScore, {
        subjectRole: 'SENDER',
        rule: 'DEFAULT',
        category,
        conversationKind: message.conversation.kind,
      });

      return 'escalated';
    }

    return 'signal';
  }

  /**
   * A member↔staff thread is **scored**, never escalated (§6.8).
   *
   * The thread already is the case staff are reading, so there is nothing to open and nobody to
   * choose: all this does is move it up the queue as the situation gets worse. Scores accumulate
   * across a thread, because a situation that escalates over five messages should climb, not sit
   * at whatever its first line scored.
   *
   * Lifted here from `GuardService.rescoreFromMessage`, which no code path ever called -- so until
   * now a Guard thread was scored on its opening message and never again, and this job walked away
   * from those threads on the strength of scoring that was not happening. The logic is unchanged;
   * only its trigger is new. It lives on this side of the line because `platform/shared` is what
   * the worker can reach, and the only trigger is the scan job that already loaded the message.
   */
  private async rescoreGuardThread(
    message: MessageRow,
    thread: { id: string; riskScore: number },
  ): Promise<'skipped' | 'signal'> {
    const assessment = await this.risk.scan(message.body ?? '');

    if (assessment.level === RiskLevel.NONE) return 'skipped';

    await this.database.$transaction([
      this.database.guardThread.update({
        where: { id: thread.id },
        data: {
          riskScore: { increment: assessment.score },
          ...(assessment.score > thread.riskScore
            ? { riskLevel: assessment.level, riskCategory: assessment.category }
            : {}),
          // A member who writes again has reopened the conversation, whatever staff had marked it.
          state: GuardThreadState.OPEN,
        },
      }),
      this.database.moderationQueueItem.updateMany({
        where: {
          targetType: ReportTargetType.CONVERSATION,
          targetId: message.conversationId,
        },
        data: { riskScore: { increment: assessment.score } },
      }),
    ]);

    return 'signal';
  }

  /**
   * The safeguarding path (§6.8.1).
   *
   * Opens the queue item the work actually reaches staff through, and records the reasoning on it
   * — which member, chosen by which rule — because the rules guess, and a reviewer who can see the
   * guess can correct it.
   */
  private async escalate(
    message: MessageRow,
    category: RiskCategory,
    tier: ContentRiskTier,
    score: number,
    classifier: { scores: Record<string, number> } | null,
  ): Promise<void> {
    const escalation = escalationFor({
      category,
      tier,
      hasThreatSignal: THREAT_SIGNAL_CATEGORIES.some(
        name => (classifier?.scores[name] ?? 0) >= THREAT_SIGNAL_AT,
      ),
      hasMinorSignal: (classifier?.scores['sexual/minors'] ?? 0) >= THREAT_SIGNAL_AT,
      conversationKind: message.conversation.kind,
    });

    const other = message.conversation.participants
      .map(participant => participant.userId)
      .find(userId => userId !== message.senderId);
    const subjectId =
      escalation.subjectRole === 'SENDER'
        ? message.senderId
        : escalation.subjectRole === 'RECIPIENT'
          ? (other ?? null)
          : null;

    await this.flag(
      message,
      escalation.subjectRole,
      subjectId,
      category,
      tier,
      score,
      {
        subjectRole: escalation.subjectRole,
        rule: escalation.rule,
        category,
        conversationKind: message.conversation.kind,
      },
      escalation,
    );

    // The table's second item: the hit also reads as something the sender did.
    if (escalation.flagSender && escalation.subjectRole !== 'SENDER') {
      await this.flag(message, 'SENDER', message.senderId, category, tier, score, {
        subjectRole: 'SENDER',
        rule: escalation.rule,
        category,
        conversationKind: message.conversation.kind,
      });
    }

    await this.record(message, category, tier, escalation, subjectId);
  }

  /**
   * One queue item, deduplicated per (subject member, conversation) while it is open (§6.8.1).
   *
   * Keyed on the **conversation** rather than the message, because a situation that escalates over
   * five messages is one piece of work. Repeat hits raise the score on the item a reviewer is
   * already looking at.
   */
  private async flag(
    message: MessageRow,
    subjectRole: string,
    subjectId: string | null,
    category: RiskCategory,
    tier: ContentRiskTier,
    score: number,
    payload: Record<string, unknown>,
    escalation?: Escalation,
  ): Promise<void> {
    const type = escalation ? ModerationQueueType.GUARD_RISK : ModerationQueueType.FLAGGED_CONTENT;
    const level = tier === ContentRiskTier.CRITICAL ? RiskLevel.CRITICAL : RiskLevel.HIGH;
    const existing = await this.database.moderationQueueItem.findFirst({
      where: {
        type,
        targetType: ReportTargetType.MESSAGE,
        state: { in: [ModerationQueueState.PENDING, ModerationQueueState.IN_REVIEW] },
        subjectUserId: subjectId,
        payload: { path: ['messageEscalation', 'conversationId'], equals: message.conversationId },
      },
      select: { id: true, riskScore: true },
    });

    const body = {
      riskLevel: level,
      riskCategory: category,
      // The verdict's own score, with the tier's floor under it: an item a reviewer sorts by
      // must not read lower than the tier it was given.
      riskScore: Math.max(score, tier === ContentRiskTier.CRITICAL ? 90 : 55),
      // Only the flagged message, never the thread around it (§6.8). Reading the rest needs a
      // thread access grant, which is §5.6's.
      payload: toJson({
        messageEscalation: {
          ...payload,
          conversationId: message.conversationId,
          messageId: message.id,
          priority: escalation?.priority ?? 'HIGH',
          // `text`, which is what §5.10 calls the words in a snapshot. It was `body` — the column
          // name — so the portal's one snapshot component read it as empty on exactly the reports
          // where the words matter most.
          snapshot: {
            capturedAt: new Date().toISOString(),
            text: excerpt(message.body ?? '', 500),
            sentAt: message.sentAt,
          },
        },
      }),
      summary: `Flagged message in a ${message.conversation.kind.toLowerCase()} thread`,
    };

    if (existing) {
      await this.database.moderationQueueItem.update({
        where: { id: existing.id },
        data: { ...body, riskScore: Math.max(existing.riskScore, body.riskScore) },
      });

      return;
    }

    const stamp = await this.deadlines.stamp({ type, riskLevel: level });

    await this.database.moderationQueueItem.create({
      data: {
        type,
        targetType: ReportTargetType.MESSAGE,
        targetId: message.id,
        subjectUserId: subjectId,
        ...stamp,
        ...body,
      },
    });
  }

  /**
   * The audit entry (§6.8), with a system actor and **no message text**.
   *
   * Written straight to the table rather than through `AuditService`, which lives in the admin
   * module: the member API does not load admin code, and this runs on whichever process has the
   * worker. There is no request context to read either — the actor is the system.
   *
   * The id, the timestamp and the digest are set here for the same reason `AuditService` sets
   * them: the trail is append-only, so there is no second write to put a hash into, and S11.3's
   * verification can only name the row that changed if the row carries its own digest. `prevHash`
   * is left null — the chain's tip is an admin-side read and this path has no business making it;
   * an unanchored row is still sealed and still digested.
   */
  private async record(
    message: MessageRow,
    category: RiskCategory,
    tier: ContentRiskTier,
    escalation: Escalation,
    subjectId: string | null,
  ): Promise<void> {
    const entry = {
      id: randomUUID(),
      occurredAt: new Date(),
      action: MESSAGE_ESCALATED_ACTION,
      area: 'SAFETY' as const,
      actorId: null,
      targetType: ReportTargetType.MESSAGE,
      targetId: message.id,
      metadata: {
        category,
        tier,
        subjectRole: escalation.subjectRole,
        // Who it is about, so "every escalation about this member" is one query. Ids only:
        // §6.8 forbids the message text here, and this is the whole trail of the decision.
        subjectId,
        rule: escalation.rule,
        conversationId: message.conversationId,
        messageId: message.id,
      },
    };

    await this.database.auditLog
      .create({
        data: {
          ...entry,
          metadata: toJson(entry.metadata),
          hash: rowDigest(entry),
        },
      })
      .catch(error => {
        // A missing audit entry must not lose the escalation it describes, and the item is already
        // written. Loud, because a silent gap in this trail is the worst of the outcomes.
        this.logger.error(
          `Could not record ${MESSAGE_ESCALATED_ACTION}: ${(error as Error).message}`,
        );
      });
  }

  /**
   * §6.8.1's "at most one new Guard case per member per 24 h" is not implemented here, because
   * this job opens no Guard case: `GuardService.createThread` creates a thread the member can
   * see, which §6.8 forbids outright, so the escalation reaches staff as a queue item only. The
   * noise it would have limited is limited instead by `flag()`, which keeps one open item per
   * (subject, conversation) however many messages hit.
   *
   * When case-opening lands with §5.12, the limit belongs in front of it, and the `subjectId` and
   * `occurredAt` on the `safety.message_escalated` audit entries are what it should read.
   */
}

type MessageRow = {
  id: string;
  body: string | null;
  senderId: string | null;
  sentAt: Date;
  conversationId: string;
  conversation: { id: string; kind: ThreadKind; participants: Array<{ userId: string }> };
};

/** The heaviest category among the signals that count, which is the rule the content scan uses. */
const heaviest = (
  signals: Array<{ category: RiskCategory; weight: number }>,
): RiskCategory | null => {
  const totals = new Map<RiskCategory, number>();

  for (const signal of signals) {
    totals.set(signal.category, (totals.get(signal.category) ?? 0) + signal.weight);
  }

  return [...totals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};
