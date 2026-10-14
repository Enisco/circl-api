import { Injectable, Logger } from '@nestjs/common';
import {
  ContentRiskTier,
  ContentScanStatus,
  ContentScanTrigger,
  ContentVisibilityState,
  MediaType,
  ModerationDecision,
  ModerationQueueState,
  ModerationQueueType,
  Prisma,
  ReportTargetType,
  RiskLevel,
  RiskTermHitOutcome,
} from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '@/infrastructure';
import { SYSTEM_CONFIG_KEYS, toJson } from '@/common';
import { CONTENT_SOURCE, ContentSource } from './content-source';
import { ContentSafetyQueue } from './content-safety.queue';
import { QueueDeadlineService } from './queue-deadline.service';
import { PRIORITY_RANK } from './queue-priority';
import { SafetyClassifierService } from './safety-classifier.service';
import { LexiconUnavailableError, RiskScannerService } from './risk-scanner.service';
import { isReachable } from './content-visibility';
import { AVATAR_MEDIA_OWNER } from './media.service';
import { SystemConfigService } from './system-config.service';
import {
  ClassifierResult,
  HELD_REASON,
  needsReview,
  scoreOf,
  stateFor,
  Verdict,
} from './safety-scoring';

/**
 * Whether an anonymous post waits for approval before anybody can read it (§7.4).
 *
 * **On since §5.9's queue rework.** It was false for three milestones, for a reason worth keeping
 * written down: pre-moderation is the right design and the spec is unambiguous about it, but there
 * was nothing that could *release* a `PENDING_APPROVAL` post. Turned on then, every anonymous post
 * would have been invisible for ever — a hold nothing can release is worse than no hold, and the
 * same mistake as switching on a classifier that does not answer.
 *
 * What made it safe is `POST admin/moderation/queue/:id/decide`: `APPROVE` publishes the post and
 * `REJECT` refuses it with words the author can read. Until that existed, an `ANONYMOUS_POST` item
 * was raised anyway — so the work was visible to staff and the §13.5 clock ran — and the post
 * stayed up. Now the item is the way the post gets out.
 */
const PRE_MODERATE_ANONYMOUS = true;

/** The queue still ranks by `RiskLevel`; §5.9 gives it the tier itself. One mapping, here. */
const QUEUE_LEVEL: Record<ContentRiskTier, RiskLevel> = {
  [ContentRiskTier.CRITICAL]: RiskLevel.CRITICAL,
  [ContentRiskTier.HIGH]: RiskLevel.HIGH,
  [ContentRiskTier.MEDIUM]: RiskLevel.MEDIUM,
  [ContentRiskTier.LOW]: RiskLevel.LOW,
  [ContentRiskTier.CLEAN]: RiskLevel.NONE,
};

/**
 * How many of a post's images go to the classifier.
 *
 * A gallery of ten photos is ten fetches the model makes while a scan is in flight, and the
 * reviewer only needs to know that *something* in the post is wrong. The first four in render
 * order are the ones a member actually sees first.
 */
const MAX_IMAGES = 4;

/**
 * Triggers that mean "look again anyway", even though the words have not changed.
 *
 * `CREATE` and `EDIT` are about new words, so an unchanged hash means there is nothing to do. The
 * other three are somebody asking for a fresh opinion — a report, the degraded sweep, a reviewer
 * pressing rescan — and the lexicon they are asking about may have gained terms since.
 */
const FRESH_LOOK: ContentScanTrigger[] = [
  ContentScanTrigger.RESCAN,
  ContentScanTrigger.REPORT,
  ContentScanTrigger.MANUAL,
];

export interface AssessInput {
  targetType: ReportTargetType;
  targetId: string;
  /** Null where the content has no single author (a group's own description). */
  authorId: string | null;
  /** The scannable text, by field name. Field names reach the reviewer, so they are the real ones. */
  fields: Record<string, string | null | undefined>;
  /** Storage keys of attached media, which are part of the hash and of the classifier's input. */
  mediaKeys?: string[];
  /** §7.4: an anonymous post waits for a human whatever it scored. */
  isAnonymous?: boolean;
  /**
   * §2.9: this content may not be published until a human approves it, whatever it scored — a
   * professional listing in a gated profession. The caller decides; the pipeline only has to hold
   * it and remember why, so that the worker pass behind the write does not publish it.
   */
  requiresApproval?: boolean;
  trigger: ContentScanTrigger;
  /**
   * `OBSERVE` records the verdict and changes nothing else: no hold, no mirrored column, no queue
   * item (§6.8).
   *
   * Private messages are scanned this way. The message is never hidden, the conversation is never
   * interrupted and no member is told, so the only thing the scan produces is evidence — and the
   * caller decides what to do with it, because only the caller knows who it should be about.
   * `ENFORCE` is everything else, and the default.
   */
  mode?: 'ENFORCE' | 'OBSERVE';
  /**
   * A classifier answer the caller already has, with the model that gave it.
   *
   * §6.8's message scan asks the classifier itself, because its rules need the threat-signal
   * scores *before* anything is written. Passing the answer in means the row records the verdict
   * the decision was actually made on, instead of a lexicon-only one that nothing will ever
   * finish — an OBSERVE scan queues no worker pass, so there is no second chance to correct it.
   *
   * Omitted means "the worker will score it", which is every content path. Present with a null
   * `result` means the classifier was asked and could not answer.
   */
  classified?: { result: ClassifierResult | null; model: string; error: string | null };
  /**
   * A line a reviewer can read in a queue list, usually the title.
   *
   * Absent means "do not change it", which matters on the worker's pass: it re-reads the content
   * rather than the summary, and an explicit null there would blank the title on an open item.
   */
  summary?: string | null;
}

export interface AssessResult {
  tier: ContentRiskTier;
  state: ContentVisibilityState;
  /** Null when nothing more is coming, which is also when the verdict is final. */
  queuedScanVersion: number | null;
}

type Tx = Prisma.TransactionClient;

/**
 * The content safety pipeline, inline half (§6.2 steps 1–4).
 *
 * One service called from every create and edit path, which is the point: the version of this that
 * each section implemented for itself is what §6.2 replaces, and the two that existed
 * (`request.service.ts` and `update.service.ts`) had already drifted — one scanned a title and a
 * description, the other scanned a body, and neither wrote down what it found.
 *
 * What happens here is deliberately cheap and deliberately synchronous: normalise, hash, run the
 * lexicon, write the verdict, mirror the visibility column, open a queue item if a human is
 * needed. About a millisecond, inside the caller's transaction, so a High lexicon hit is **held
 * before the write commits** — §6.7's one absolute rule is that this path never fails open.
 *
 * The classifier is the other half and runs in a worker. When it is switched off (§6.7) there is
 * no second half: the lexicon verdict is the verdict, recorded as `DEGRADED`, and nothing waits.
 */
@Injectable()
export class ContentSafetyService {
  private readonly logger = new Logger(ContentSafetyService.name);

  constructor(
    private readonly database: PrismaService,
    private readonly risk: RiskScannerService,
    private readonly config: SystemConfigService,
    private readonly classifier: SafetyClassifierService,
    private readonly queue: ContentSafetyQueue,
    private readonly deadlines: QueueDeadlineService,
  ) {}

  /**
   * Scans one piece of content and applies the inline verdict.
   *
   * Takes the caller's `tx` so the verdict and the content are one write: a post that exists
   * without a safety row is a post nothing has looked at, and a row without its post is a queue
   * item pointing at nothing.
   */
  async assess(tx: Tx, input: AssessInput): Promise<AssessResult> {
    const classifier = await this.config.get(SYSTEM_CONFIG_KEYS.CLASSIFIER);
    const hash = this.hashOf(input);
    let assessment: Awaited<ReturnType<RiskScannerService['scanFields']>>;

    try {
      assessment = await this.risk.scanFields(input.fields);
    } catch (error) {
      if (!(error instanceof LexiconUnavailableError)) throw error;

      // §6.7, the cold-start case: the write is accepted, the content is recorded as unscanned and
      // kept out of feeds, and `safety.rescan-degraded` comes back to it. Refusing the post would
      // turn a database blip in one table into "you cannot post", and publishing it unscanned is
      // the one thing this pipeline must never do.
      return this.unscanned(tx, input, hash);
    }

    const existing = await tx.contentSafety.findUnique({
      where: {
        targetType_targetId: { targetType: input.targetType, targetId: input.targetId },
      },
    });

    // An edit that changed nothing scannable is not a new scan (§6.2 step 2). Without this, every
    // "mark as resolved" and every price change re-queued the post for a human.
    if (existing && existing.contentHash === hash && !FRESH_LOOK.includes(input.trigger)) {
      return {
        tier: existing.tier,
        state: existing.visibilityState,
        queuedScanVersion: null,
      };
    }

    const thresholds = await this.risk.thresholds();
    const criticalCategories = await this.risk.criticalCategories();
    const verdict = scoreOf({
      lexiconScore: assessment.score,
      lexiconCategory: assessment.category,
      lexiconCriticalHit: assessment.criticalHit,
      // Inline, there is usually no classifier result yet and the worker re-scores with one. The
      // exception is a caller that already asked (§6.8).
      classifier: input.classified?.result ?? null,
      thresholds,
      criticalCategories,
      weight: classifier.weight,
    });

    const observing = input.mode === 'OBSERVE';
    const scanned = observing
      ? { state: ContentVisibilityState.VISIBLE, heldReason: null }
      : stateFor({
          tier: verdict.tier,
          isAnonymous: PRE_MODERATE_ANONYMOUS && (input.isAnonymous ?? false),
          requiresApproval: input.requiresApproval ?? false,
          // A clean post waits only while something is actually coming (§6.5). Every other tier
          // already has a state of its own, so this decides the CLEAN/LOW case and nothing else.
          //
          // And only on the way **in**. A rescan of something already published must not pull it
          // back out of feeds for the second the classifier takes — which, once reports trigger a
          // scan (§7.1), would hand anybody a way to make any post flicker out of sight by
          // reporting it, and would have the ten-minute sweep doing the same thing unprompted.
          classifierPending:
            classifier.enabled &&
            (!existing ||
              input.trigger === ContentScanTrigger.CREATE ||
              input.trigger === ContentScanTrigger.EDIT),
        });
    const provisional = observing ? scanned : this.withoutAutoRelease(scanned, existing);

    const scanVersion = (existing?.scanVersion ?? 0) + 1;
    const now = new Date();
    // PENDING means "a worker pass is coming". It is not, for a caller that brought its own
    // answer: that verdict is final the moment it is written, and a row left PENDING for ever
    // reads as a classifier that never came back.
    const scanStatus = input.classified
      ? input.classified.result
        ? ContentScanStatus.COMPLETE
        : ContentScanStatus.DEGRADED
      : classifier.enabled
        ? ContentScanStatus.PENDING
        : ContentScanStatus.DEGRADED;
    const safety = await tx.contentSafety.upsert({
      where: {
        targetType_targetId: { targetType: input.targetType, targetId: input.targetId },
      },
      create: {
        targetType: input.targetType,
        targetId: input.targetId,
        authorId: input.authorId,
        tier: verdict.tier,
        visibilityState: provisional.state,
        finalScore: verdict.finalScore,
        lexiconScore: assessment.score,
        lexiconSignals: toJson(assessment.signals),
        category: verdict.category,
        scanStatus,
        scanVersion,
        contentHash: hash,
        ...this.stateTimestamps(provisional.state, provisional.heldReason, now),
      },
      update: {
        authorId: input.authorId,
        tier: verdict.tier,
        visibilityState: provisional.state,
        finalScore: verdict.finalScore,
        lexiconScore: assessment.score,
        lexiconSignals: toJson(assessment.signals),
        category: verdict.category,
        scanStatus,
        scanVersion,
        contentHash: hash,
        // A re-scan after an edit clears the previous human decision: it was about different
        // words. §6.6 keeps the decision in the history, which is `ContentScan`.
        reviewedAt: null,
        reviewedById: null,
        reviewDecision: null,
        ...this.stateTimestamps(provisional.state, provisional.heldReason, now),
      },
    });

    await tx.contentScan.create({
      data: {
        contentSafetyId: safety.id,
        trigger: input.trigger,
        scanVersion,
        contentHash: hash,
        lexiconScore: assessment.score,
        lexiconSignals: toJson(assessment.signals),
        finalScore: verdict.finalScore,
        tier: verdict.tier,
        degraded: scanStatus === ContentScanStatus.DEGRADED,
        ...(input.classified
          ? {
              classifierScores: toJson(input.classified.result?.scores ?? {}),
              classifierModel: input.classified.model,
              classifierError: input.classified.error,
            }
          : {}),
      },
    });

    await this.recordHits(tx, safety.id, input, assessment.signals);

    // Observing stops here: the verdict is written down and nothing else happens. No column is
    // mirrored (a message has none), nothing is held, and the queue item — if there is to be one —
    // belongs to the caller, which knows who it should be about (§6.8.1).
    if (observing) {
      return { tier: verdict.tier, state: provisional.state, queuedScanVersion: null };
    }

    await this.mirror(tx, input.targetType, input.targetId, provisional.state);

    if (needsReview(verdict.tier) || input.isAnonymous) {
      await this.enqueueForReview(tx, input, verdict, assessment.signals);
    }

    if (classifier.enabled) {
      await this.queue.enqueue({
        targetType: input.targetType,
        targetId: input.targetId,
        scanVersion,
        trigger: input.trigger,
      });
    }

    return {
      tier: verdict.tier,
      state: provisional.state,
      queuedScanVersion: classifier.enabled ? scanVersion : null,
    };
  }

  /**
   * Scans content that is already written, reading it from its own row (§7.1's `REPORT` trigger,
   * and §5.7's manual rescan when that arrives).
   *
   * The caller has a target id and nothing else, so the fields come from `CONTENT_SOURCE` — the
   * same way the worker reads them, which is what makes a report and a scheduled rescan look at
   * the same text under the same field names.
   *
   * Null for a target with no row to read: a conversation, a member. The caller keeps whatever it
   * already knew rather than being handed a verdict about nothing.
   */
  async rescan(
    tx: Tx,
    input: {
      targetType: ReportTargetType;
      targetId: string;
      authorId: string | null;
      trigger: ContentScanTrigger;
      summary?: string | null;
    },
  ): Promise<AssessResult | null> {
    const source = CONTENT_SOURCE[input.targetType];

    if (!source) return null;

    const [content] = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT * FROM "${source.table}" WHERE "id" = $1`,
      input.targetId,
    );

    if (!content) return null;

    return this.assess(tx, {
      targetType: input.targetType,
      targetId: input.targetId,
      authorId: input.authorId,
      fields: source.toFields(content),
      mediaKeys: await this.imagesFor(source, input.targetId, content),
      trigger: input.trigger,
      // A message is never held, whatever a report says about it (§6.8).
      mode: input.targetType === ReportTargetType.MESSAGE ? 'OBSERVE' : 'ENFORCE',
      summary: input.summary,
    });
  }

  /**
   * The classifier half (§6.2 steps 5–8), run from the worker.
   *
   * Guarded by `scanVersion`, which is what makes it idempotent and what makes a retry safe: a job
   * carrying an older version than the row has is a scan of words that have since been edited, and
   * it does nothing. The same guard is why a human decision taken while the job was in flight is
   * not overwritten — the decision bumps nothing, but `scanStatus` has moved to COMPLETE and the
   * verdict below refuses to re-apply.
   *
   * Returns which of the four things happened, because the worker's retry depends on it:
   * `pending` means the write has not committed yet and the job should come back.
   */
  async finalise(
    job: {
      targetType: ReportTargetType;
      targetId: string;
      scanVersion: number;
      trigger: ContentScanTrigger;
    },
    options: { lastAttempt: boolean },
  ): Promise<'done' | 'stale' | 'pending' | 'degraded'> {
    const row = await this.database.contentSafety.findUnique({
      where: {
        targetType_targetId: { targetType: job.targetType, targetId: job.targetId },
      },
    });

    if (!row || row.scanVersion < job.scanVersion) return 'pending';
    if (row.scanVersion > job.scanVersion) return 'stale';
    if (row.scanStatus !== ContentScanStatus.PENDING) return 'stale';

    const source = CONTENT_SOURCE[job.targetType];

    if (!source) {
      this.logger.warn(`No source for ${job.targetType}; cannot classify`);

      return this.recordDegraded(row, job, 'no source for this target type');
    }

    const [content] = await this.database.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT * FROM "${source.table}" WHERE "id" = $1`,
      job.targetId,
    );

    // Deleted between the write and the scan. Nothing to classify and nothing to hold — and the
    // verdict goes with it, because a row describing content that no longer exists can never be
    // finished: the sweep would set it PENDING, the worker would find nothing again, and the two
    // would pass it back and forth on every pass for ever.
    if (!content) {
      await this.forget(job.targetType, job.targetId);

      return 'stale';
    }

    const fields = source.toFields(content);
    const mediaKeys = await this.imagesFor(source, job.targetId, content);
    const { result, model, error } = await this.classifier.classify({ fields, mediaKeys });

    if (!result) {
      // Retry while there are attempts left (§6.7: 1s, 4s, 15s), then the lexicon verdict stands.
      if (!options.lastAttempt && error) throw new Error(error);

      return this.recordDegraded(row, job, error);
    }

    const [thresholds, criticalCategories, settings] = await Promise.all([
      this.risk.thresholds(),
      this.risk.criticalCategories(),
      this.config.get(SYSTEM_CONFIG_KEYS.CLASSIFIER),
    ]);
    const signals = (row.lexiconSignals ?? []) as Array<{ weight: number; category: string }>;
    const verdict = scoreOf({
      lexiconScore: row.lexiconScore,
      lexiconCategory: row.category,
      // Recomputed from the stored signals rather than carried in the job: the signals are the
      // evidence, and deriving the flag from them keeps one definition of what "severe on its
      // own" means.
      lexiconCriticalHit: signals.some(
        signal => signal.weight >= thresholds.high && criticalCategories.includes(signal.category),
      ),
      classifier: result,
      thresholds,
      criticalCategories,
      weight: settings.weight,
    });

    const scanned = stateFor({
      tier: verdict.tier,
      isAnonymous: PRE_MODERATE_ANONYMOUS && row.heldReason === HELD_REASON.ANONYMOUS,
      // Recomputed from the row rather than carried in the job, for the same reason as
      // `isAnonymous`: the job is a few ids, and a hold the worker forgets about is a hold the
      // worker releases.
      requiresApproval: row.heldReason === HELD_REASON.AWAITING_APPROVAL,
      classifierPending: false,
    });
    const state = this.withoutAutoRelease(scanned, row);

    await this.database.$transaction(async tx => {
      // The guard again, inside the transaction: between the read above and here, an edit could
      // have bumped the version or a reviewer could have decided.
      const current = await tx.contentSafety.findUnique({
        where: { id: row.id },
        select: { scanVersion: true, scanStatus: true },
      });

      if (current?.scanVersion !== job.scanVersion) return;
      if (current.scanStatus !== ContentScanStatus.PENDING) return;

      await tx.contentSafety.update({
        where: { id: row.id },
        data: {
          tier: verdict.tier,
          category: verdict.category,
          finalScore: verdict.finalScore,
          classifierScores: toJson(result.scores),
          classifierFlagged: result.confident,
          scanStatus: ContentScanStatus.COMPLETE,
          visibilityState: state.state,
          ...this.stateTimestamps(state.state, state.heldReason, new Date()),
        },
      });

      await tx.contentScan.create({
        data: {
          contentSafetyId: row.id,
          trigger: job.trigger,
          scanVersion: job.scanVersion,
          contentHash: row.contentHash ?? '',
          lexiconScore: row.lexiconScore,
          lexiconSignals: row.lexiconSignals ?? undefined,
          classifierModel: model,
          classifierScores: toJson(result.scores),
          finalScore: verdict.finalScore,
          tier: verdict.tier,
          degraded: false,
        },
      });

      await this.mirror(tx, job.targetType, job.targetId, state.state);

      if (needsReview(verdict.tier)) {
        await this.enqueueForReview(
          tx,
          {
            targetType: job.targetType,
            targetId: job.targetId,
            authorId: row.authorId,
            fields: {},
            trigger: job.trigger,
            isAnonymous: row.heldReason === HELD_REASON.ANONYMOUS,
          },
          verdict,
          row.lexiconSignals,
        );
      } else {
        await this.withdraw(tx, job.targetType, job.targetId);
      }
    });

    return 'done';
  }

  /**
   * The lexicon verdict stands, and the row says why (§6.7).
   *
   * `DEGRADED` rather than `FAILED`: the content *was* scanned, by half the pipeline. The
   * distinction is what `safety.rescan-degraded` selects on, and what a dashboard counts to say
   * "the classifier has been down for an hour".
   */
  private async recordDegraded(
    row: {
      id: string;
      lexiconScore: number;
      lexiconSignals: unknown;
      contentHash: string | null;
      tier: ContentRiskTier;
      finalScore: number;
      visibilityState: ContentVisibilityState;
      heldReason: string | null;
    },
    job: {
      scanVersion: number;
      trigger: ContentScanTrigger;
      targetType: ReportTargetType;
      targetId: string;
    },
    error: string | null,
  ): Promise<'degraded'> {
    // A clean item that was waiting for the classifier is published on the lexicon's word, which
    // is what §6.5 says happens when the job exhausts its retries.
    const release =
      row.heldReason === HELD_REASON.PENDING_SCAN
        ? ContentVisibilityState.VISIBLE
        : row.visibilityState;

    await this.database.$transaction(async tx => {
      await tx.contentSafety.update({
        where: { id: row.id },
        data: {
          scanStatus: ContentScanStatus.DEGRADED,
          visibilityState: release,
          ...(release === ContentVisibilityState.VISIBLE
            ? { heldReason: null, limitedAt: null }
            : {}),
        },
      });

      await tx.contentScan.create({
        data: {
          contentSafetyId: row.id,
          trigger: job.trigger,
          scanVersion: job.scanVersion,
          contentHash: row.contentHash ?? '',
          lexiconScore: row.lexiconScore,
          lexiconSignals: (row.lexiconSignals as never) ?? undefined,
          classifierError: error?.slice(0, 500) ?? 'classifier unavailable',
          finalScore: row.finalScore,
          tier: row.tier,
          degraded: true,
        },
      });

      if (release !== row.visibilityState) {
        await this.mirror(tx, job.targetType, job.targetId, release);
      }
    });

    return 'degraded';
  }

  /**
   * Closes an item the pipeline raised and then changed its mind about.
   *
   * A weak lexicon hit that the classifier disagrees with ends up under the review threshold — the
   * post is published, and without this a reviewer still opens a flag about live, clean content.
   * Nobody reported it: a scanner raised it and the full scan withdrew it, so the pipeline closes
   * its own item rather than spending somebody's attention on it.
   *
   * Only while it is still `PENDING`. An item a human has claimed or decided is theirs, and
   * §6.6 is the only thing that may finish it.
   */
  private async withdraw(tx: Tx, targetType: ReportTargetType, targetId: string): Promise<void> {
    await tx.moderationQueueItem.updateMany({
      where: {
        targetType,
        targetId,
        type: { in: [ModerationQueueType.FLAGGED_CONTENT, ModerationQueueType.GUARD_RISK] },
        state: ModerationQueueState.PENDING,
        decidedAt: null,
      },
      data: {
        state: ModerationQueueState.RESOLVED,
        decision: ModerationDecision.NO_ACTION,
        decisionNote: 'Withdrawn by the full scan: the classifier cleared it.',
        decidedAt: new Date(),
      },
    });
  }

  /**
   * Whether the state on this row was a person's decision rather than a scan's.
   *
   * `reviewedById` is the direct answer and `STAFF_HIDE` the one a re-scan leaves behind: the
   * upsert in `assess` clears the reviewer on an edit, and `withoutAutoRelease` carries the hold
   * reason through precisely so that this still answers truthfully afterwards.
   */
  private heldByHuman(row: { reviewedById?: string | null; heldReason: string | null }): boolean {
    return !!row.reviewedById || row.heldReason === HELD_REASON.STAFF_HIDE;
  }

  /**
   * Drops the verdict for content that is physically gone.
   *
   * Only reached when the row the scan was about has been hard-deleted: a soft delete leaves the
   * row in place, and content that has not committed yet is caught by the version guard above and
   * retried. `RiskTermHit` rows are deliberately left (their `contentSafetyId` is `SetNull`) —
   * they are a term's hit count, which is about the lexicon rather than about this one post.
   */
  private async forget(targetType: ReportTargetType, targetId: string): Promise<void> {
    await this.database.$transaction(async tx => {
      await this.withdraw(tx, targetType, targetId);
      await tx.contentSafety.deleteMany({ where: { targetType, targetId } });
    });
  }

  /**
   * The images this target is showing, which the classifier takes alongside its text (§6.1).
   *
   * One query: `attach` stamps every photo with its owner, so a post's images are a lookup on
   * `(owner_type, owner_id)`. A target that *is* an image carries its key on its own row instead.
   *
   * Only `IMAGE`. The model fetches what it is given, and it cannot do anything with a video or a
   * voice note — the AV scan §13 describes is a different job with a different tool.
   */
  private async imagesFor(
    source: ContentSource,
    targetId: string,
    content: Record<string, unknown>,
  ): Promise<string[]> {
    if (source.ownKey) {
      const key = content[source.ownKey];

      return typeof key === 'string' ? [key] : [];
    }

    // The gallery **and** the poster frames: a poster is the only still a video has, so leaving it
    // out would mean a clip nothing ever looked at.
    const owners = [...(source.mediaOwners ?? []), ...(source.posterOwners ?? [])];

    if (!owners.length) return [];

    const rows = await this.database.media.findMany({
      where: {
        ownerType: { in: owners },
        ownerId: targetId,
        type: MediaType.IMAGE,
      },
      select: { storageKey: true },
      orderBy: { position: 'asc' },
      take: MAX_IMAGES,
    });

    return rows.map(row => row.storageKey);
  }

  /**
   * §6.1: an image's verdict propagates to whatever was showing it.
   *
   * Today that is an avatar, and the propagation clears the key rather than filtering on read.
   * `users.avatar_key` is read in forty-odd places — every author line, every thread list, every
   * admin table — and a state that has to be checked in forty places is one that will be missed
   * in one of them. So a held avatar is **no** avatar, which is exactly what all forty already
   * render for a member who never set one. The `media` row keeps the verdict, so an approval can
   * put the key back.
   *
   * `LIMITED` keeps the avatar. It means "not in feeds", and an avatar is not a feed item: the
   * provisional LIMITED every new upload gets while the classifier thinks (§6.5) would otherwise
   * blank every member's photo for a second and a half.
   */
  private async propagateMedia(
    tx: Tx,
    mediaId: string,
    state: ContentVisibilityState,
  ): Promise<void> {
    if (isReachable(state)) {
      // Put back — unless the member has set another one since, which is theirs to keep.
      await tx.$executeRawUnsafe(
        `UPDATE "users" SET "avatar_key" = m."storage_key"
           FROM "media" m
          WHERE m."id" = $1 AND m."owner_type" = $2
            AND "users"."id" = m."owner_id" AND "users"."avatar_key" IS NULL`,
        mediaId,
        AVATAR_MEDIA_OWNER,
      );

      return;
    }

    // Only if it is still the avatar on show. A held photo that was already replaced is history.
    await tx.$executeRawUnsafe(
      `UPDATE "users" SET "avatar_key" = NULL
         FROM "media" m
        WHERE m."id" = $1 AND m."owner_type" = $2
          AND "users"."id" = m."owner_id" AND "users"."avatar_key" = m."storage_key"`,
      mediaId,
      AVATAR_MEDIA_OWNER,
    );
  }

  /**
   * A human's decision about content (§6.6).
   *
   * Records who decided and what on the verdict row, then mirrors the state they decided on. The
   * two have to move together: the mirrored column is what every feed reads, and the verdict row
   * is what tells a reviewer — and the author, through §6.5 — that a person rather than a scanner
   * made this call.
   *
   * `heldReason` is cleared whichever way the decision went. It answers "why is this not visible
   * yet", and once somebody has looked, the answer is their decision rather than a scanner's
   * threshold.
   *
   * Content that was never held gets a row update and a no-op mirror, which is right: deciding
   * that something visible is fine is still a decision, and §6.6's history is built from these.
   */
  async applyDecision(
    tx: Tx,
    input: {
      targetType: ReportTargetType;
      targetId: string;
      state: ContentVisibilityState;
      decision: ModerationDecision;
      reviewerId: string;
    },
  ): Promise<void> {
    const now = new Date();

    await tx.contentSafety.updateMany({
      where: { targetType: input.targetType, targetId: input.targetId },
      data: {
        visibilityState: input.state,
        heldReason: null,
        reviewedAt: now,
        reviewedById: input.reviewerId,
        reviewDecision: input.decision,
        ...(input.state === ContentVisibilityState.HELD ? { heldAt: now } : {}),
      },
    });

    await this.mirror(tx, input.targetType, input.targetId, input.state);
  }

  /**
   * Writes the content row's own `visibilityState`.
   *
   * The duplication is §4.5's Decision: a feed asks the table it is already reading rather than
   * joining a polymorphic safety table. Public, because the staff hide/restore paths and the
   * worker's verdict need the same one line.
   */
  async mirror(
    tx: Tx,
    targetType: ReportTargetType,
    targetId: string,
    state: ContentVisibilityState,
  ): Promise<void> {
    const source = CONTENT_SOURCE[targetType];
    const table = source?.table;
    const column = source?.column ?? 'visibility_state';

    if (!table) {
      // A scannable kind with no column yet: the safety row is still written, so nothing is lost,
      // but saying so out loud is better than a silent no-op on a hold.
      this.logger.warn(`No visibility column for ${targetType}; verdict recorded but not mirrored`);

      return;
    }

    await tx.$executeRawUnsafe(
      `UPDATE "${table}" SET "${column}" = $1::"ContentVisibilityState" WHERE "id" = $2`,
      state,
      targetId,
    );

    // Here rather than at each of the three call sites, because all three of them — the inline
    // verdict, the worker's and a staff release — have to propagate it.
    if (targetType === ReportTargetType.MEDIA) await this.propagateMedia(tx, targetId, state);
  }

  /**
   * A re-scan may not publish what a human held (§6.6).
   *
   * An author whose post was held — by a scanner or by a staff member — can edit it. If the new
   * words are clean, the scan says VISIBLE, and taking that at face value would hand every held
   * post a one-keystroke release: edit, publish, nobody looked. §6.6 is explicit that a re-scan
   * never auto-downgrades a held item; the most it can do is move it to LIMITED and put it in
   * front of a human, which is what this does.
   *
   * Three things make this harder than one comparison, and all three were wrong before:
   *
   * 1. **An edit runs this twice.** The inline pass softens the hold to LIMITED, and the worker
   *    pass behind the same edit then reads the row the inline pass wrote. LIMITED is reachable,
   *    so by the second pass `existing.visibilityState` no longer says the content was held, and
   *    the worker published it. The state alone cannot answer this after the first pass, so
   *    `heldByHuman` is consulted as well — which only works because of (2).
   * 2. **The edit erases the evidence.** The upsert above clears `reviewedById` (the decision was
   *    about different words) and rewrites `heldReason`. So the softened hold has to carry the
   *    original reason forward, or the only two markers `heldByHuman` reads are both gone by the
   *    time the worker looks.
   * 3. **A rejection is not a hold.** `REJECTED` and `PENDING_APPROVAL` are decisions somebody
   *    made, and LIMITED is *reachable* — on the author’s own profile and at a direct link. So
   *    softening those two to LIMITED does not soften a hold, it reverses a decision, and
   *    `reviewStatusOf(LIMITED)` is null so the author is not even told. They stay where they are.
   *
   * A scanner hold with no human behind it is deliberately still releasable: the classifier
   * overruling a weak lexicon hit is what `withdraw` exists for.
   */
  private withoutAutoRelease(
    scanned: { state: ContentVisibilityState; heldReason: string | null },
    existing: { visibilityState: ContentVisibilityState; heldReason: string | null } | null,
  ): { state: ContentVisibilityState; heldReason: string | null } {
    if (!existing) return scanned;
    if (!isReachable(scanned.state)) return scanned;
    if (isReachable(existing.visibilityState) && !this.heldByHuman(existing)) return scanned;

    if (
      existing.visibilityState === ContentVisibilityState.REJECTED ||
      existing.visibilityState === ContentVisibilityState.PENDING_APPROVAL
    ) {
      return { state: existing.visibilityState, heldReason: existing.heldReason };
    }

    return {
      state: ContentVisibilityState.LIMITED,
      // The reason it was held in the first place, not this scan’s. See (2) above: this is the
      // one field that survives the edit, and the worker pass behind the edit reads it.
      heldReason: existing.heldReason ?? scanned.heldReason ?? HELD_REASON.AUTO_MEDIUM,
    };
  }

  /**
   * The verdict for content nothing could scan (§6.7).
   *
   * Limited rather than visible, `PENDING` rather than `DEGRADED`: degraded means the lexicon ran
   * and the classifier did not, and this is neither having run. The rescan job selects on exactly
   * this state.
   */
  private async unscanned(tx: Tx, input: AssessInput, hash: string): Promise<AssessResult> {
    this.logger.error(
      `No lexicon available; ${input.targetType} ${input.targetId} recorded unscanned and limited`,
    );

    const now = new Date();
    const safety = await tx.contentSafety.upsert({
      where: {
        targetType_targetId: { targetType: input.targetType, targetId: input.targetId },
      },
      create: {
        targetType: input.targetType,
        targetId: input.targetId,
        authorId: input.authorId,
        visibilityState: ContentVisibilityState.LIMITED,
        scanStatus: ContentScanStatus.PENDING,
        contentHash: hash,
        heldReason: HELD_REASON.PENDING_SCAN,
        limitedAt: now,
      },
      update: {
        contentHash: hash,
        scanStatus: ContentScanStatus.PENDING,
      },
    });

    await this.mirror(tx, input.targetType, input.targetId, safety.visibilityState);

    return { tier: safety.tier, state: safety.visibilityState, queuedScanVersion: null };
  }

  /** `heldAt` and `limitedAt` are when it happened, so "held for three days" is answerable. */
  private stateTimestamps(
    state: ContentVisibilityState,
    heldReason: string | null,
    now: Date,
  ): { heldReason: string | null; heldAt: Date | null; limitedAt: Date | null } {
    return {
      heldReason,
      heldAt:
        state === ContentVisibilityState.HELD || state === ContentVisibilityState.PENDING_APPROVAL
          ? now
          : null,
      limitedAt: state === ContentVisibilityState.LIMITED ? now : null,
    };
  }

  /**
   * sha256 over the scanned fields and the attached media keys (§6.2 step 2).
   *
   * Field names are in the hash as well as the values: moving the same sentence from a title into
   * a description is a different piece of content to a reviewer, and should be scanned again.
   */
  private hashOf(input: AssessInput): string {
    const parts = Object.entries(input.fields)
      .filter(([, value]) => value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([field, value]) => `${field}=${value}`);

    return createHash('sha256')
      .update([...parts, ...[...(input.mediaKeys ?? [])].sort()].join('\u0000'), 'utf8')
      .digest('hex');
  }

  /**
   * One row per matched term, and the term's own counters.
   *
   * This is the only evidence a lexicon entry is worth having. `hitCount` is maintained here
   * rather than counted later for the reason §4.5 gives: the question is asked on a list page.
   * Rows for the previous scan version are left alone — they are what a reviewer decided about.
   */
  private async recordHits(
    tx: Tx,
    contentSafetyId: string,
    input: AssessInput,
    signals: Array<{ termId: string }>,
  ): Promise<void> {
    const termIds = [...new Set(signals.map(signal => signal.termId))];

    if (!termIds.length) return;

    // One **open** hit per term per piece of content. An edit that still matches the same phrase
    // is the same unjudged hit, not a second one: without this, a member editing a post four
    // times left four PENDING rows for one phrase, inflating the term's hit count and the queue's
    // "unresolved" figure with the same event.
    const open = await tx.riskTermHit.findMany({
      where: {
        targetType: input.targetType,
        targetId: input.targetId,
        outcome: RiskTermHitOutcome.PENDING,
        riskTermId: { in: termIds },
      },
      select: { riskTermId: true },
    });
    const already = new Set(open.map(hit => hit.riskTermId));
    const fresh = termIds.filter(termId => !already.has(termId));

    if (!fresh.length) return;

    await tx.riskTermHit.createMany({
      data: fresh.map(riskTermId => ({
        riskTermId,
        contentSafetyId,
        targetType: input.targetType,
        targetId: input.targetId,
      })),
    });

    await tx.riskTerm.updateMany({
      where: { id: { in: fresh } },
      data: { hitCount: { increment: 1 }, lastHitAt: new Date() },
    });
  }

  /**
   * The queue item a human works from (§6.5).
   *
   * Three producers, one row each: an anonymous post waits for approval, a critical tier opens a
   * `GUARD_RISK` item because somebody may be in danger, and everything else in between is
   * `FLAGGED_CONTENT`. Upserted on the queue's own `(type, targetType, targetId)` key, so a second
   * edit updates the item a reviewer is already looking at rather than opening a second one.
   */
  private async enqueueForReview(
    tx: Tx,
    input: AssessInput,
    verdict: Verdict,
    signals: unknown,
  ): Promise<void> {
    const type = input.isAnonymous
      ? ModerationQueueType.ANONYMOUS_POST
      : verdict.tier === ContentRiskTier.CRITICAL
        ? ModerationQueueType.GUARD_RISK
        : ModerationQueueType.FLAGGED_CONTENT;

    // The **verdict's** level and score, not the lexicon's. The queue sorts on these, and a list
    // ordered by a number that disagrees with the decision beside it is worse than no order: a
    // safeguarding disclosure floored to critical (§6.3 rule 3) would have sat in the list
    // reading 65/HIGH while the hold said CRITICAL. The lexicon's own score stays on the safety
    // row, where a reviewer can see the two numbers that produced it.
    const payload = {
      riskLevel: QUEUE_LEVEL[verdict.tier],
      riskCategory: verdict.category,
      riskScore: verdict.finalScore,
      riskSignals: toJson(signals),
    };
    // `summary` is the line a reviewer reads in the queue list, and the worker does not have it:
    // it re-reads the content, not the title the write path passed. So an **absent** summary
    // means "leave the one that is there" rather than "set it to null", which is what the first
    // version of the worker did — it blanked the title of every item it finished.
    const summary = input.summary === undefined ? {} : { summary: input.summary };
    // The priority and the deadline. On `create` only: an item a reviewer is already looking at
    // must not have its clock reset because the author edited the post underneath them, which is
    // the whole reason this sits apart from `payload`.
    const stamp = await this.deadlines.stamp({ type, riskLevel: payload.riskLevel });

    const open = await tx.moderationQueueItem.findUnique({
      where: {
        type_targetType_targetId: {
          type,
          targetType: input.targetType,
          targetId: input.targetId,
        },
      },
      select: { priority: true, createdAt: true },
    });

    // An edit that made the content *worse* raises the band, and only ever raises it (§7.1). A
    // post edited from MEDIUM into something critical would otherwise keep the NORMAL priority it
    // was created with and stay where it was in the queue — the one place the reviewer would never
    // think to look for it. The deadline is recomputed from the **original** creation time, so a
    // raise can only bring it forward: an escalation must not buy the item more time.
    const raise =
      open && PRIORITY_RANK[stamp.priority] > PRIORITY_RANK[open.priority]
        ? await this.deadlines.stamp({
            type,
            riskLevel: payload.riskLevel,
            createdAt: open.createdAt,
          })
        : {};

    await tx.moderationQueueItem.upsert({
      where: {
        type_targetType_targetId: {
          type,
          targetType: input.targetType,
          targetId: input.targetId,
        },
      },
      create: {
        type,
        targetType: input.targetType,
        targetId: input.targetId,
        subjectUserId: input.authorId,
        ...stamp,
        ...payload,
        ...summary,
      },
      // An edit that is still over the line updates the evidence on the open item. A reviewer who
      // has already decided is not reopened — that is §6.6's job, with the history to show them.
      update: { ...payload, ...summary, ...raise },
    });
  }

  /** The reason a hold exists, for the few callers that set one by hand. */
  static readonly HELD_REASON = HELD_REASON;
}
