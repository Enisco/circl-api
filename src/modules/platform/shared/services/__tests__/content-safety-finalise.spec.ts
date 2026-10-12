import {
  ContentRiskTier,
  ContentScanStatus,
  ContentScanTrigger,
  ContentVisibilityState,
  ReportTargetType,
  RiskCategory,
} from '@prisma/client';
import { SYSTEM_CONFIG_DEFAULTS } from '@/common';
import { ContentSafetyService } from '../content-safety.service';
import { queueDueBy, queuePriorityFor } from '../queue-priority';
import { HELD_REASON } from '../safety-scoring';

/**
 * `finalise` is the worker's half of the pipeline, and the one method in it that cannot be reached
 * end-to-end here: it needs a classifier that answers, and this environment has a placeholder API
 * key. So it is tested against stubs — which is also the only way to drive the branches that
 * matter, because they are about *disagreement* between the two scans and about what has happened
 * to the row while the job was in flight.
 */
const THRESHOLDS = SYSTEM_CONFIG_DEFAULTS['safety.tierThresholds'];
const CLASSIFIER = SYSTEM_CONFIG_DEFAULTS['safety.classifier'];
const CRITICAL = SYSTEM_CONFIG_DEFAULTS['safety.criticalCategories'];

const JOB = {
  targetType: ReportTargetType.REQUEST,
  targetId: 'target-1',
  scanVersion: 2,
  trigger: ContentScanTrigger.CREATE,
};

/** The row as the inline scan left it, overridable per test. */
const safetyRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'safety-1',
  targetType: ReportTargetType.REQUEST,
  targetId: 'target-1',
  authorId: 'author-1',
  tier: ContentRiskTier.CLEAN,
  visibilityState: ContentVisibilityState.LIMITED,
  finalScore: 0,
  lexiconScore: 0,
  lexiconSignals: [],
  category: null,
  scanStatus: ContentScanStatus.PENDING,
  scanVersion: 2,
  contentHash: 'hash',
  heldReason: HELD_REASON.PENDING_SCAN,
  reviewedById: null,
  ...overrides,
});

const build = (options: {
  row?: Record<string, unknown> | null;
  classify?: { score: number; confident?: boolean; category?: RiskCategory | null } | null;
  error?: string | null;
  /** An open queue item already on this target, for the escalation rule. */
  openItem?: { priority: string; createdAt: Date } | null;
}) => {
  const writes: Record<string, unknown[]> = {
    update: [],
    scan: [],
    queueUpsert: [],
    queueWithdraw: [],
    mirror: [],
  };
  const tx = {
    contentSafety: {
      findUnique: jest.fn(async () => (options.row === null ? null : safetyRow(options.row))),
      update: jest.fn(async (args: unknown) => {
        writes.update.push(args);

        return {};
      }),
    },
    contentScan: {
      create: jest.fn(async (args: unknown) => {
        writes.scan.push(args);

        return {};
      }),
    },
    moderationQueueItem: {
      // Read before the upsert, so an edit that raised the band can raise the item's priority
      // without resetting its clock (§7.1: escalation only ever raises).
      findUnique: jest.fn(async () => options.openItem ?? null),
      upsert: jest.fn(async (args: unknown) => {
        writes.queueUpsert.push(args);

        return {};
      }),
      updateMany: jest.fn(async (args: unknown) => {
        writes.queueWithdraw.push(args);

        return { count: 1 };
      }),
    },
    $executeRawUnsafe: jest.fn(async (...args: unknown[]) => {
      writes.mirror.push(args);

      return 1;
    }),
  };
  const database = {
    contentSafety: {
      findUnique: jest.fn(async () => (options.row === null ? null : safetyRow(options.row))),
    },
    // §6.1 scans the post's images along with its words, so the worker looks them up.
    media: { findMany: jest.fn(async () => [{ storageKey: 'uploads/photo-1.jpg' }]) },
    $queryRawUnsafe: jest.fn(async () => [{ id: 'target-1', title: 'a title', description: null }]),
    $transaction: jest.fn(async (work: (client: unknown) => Promise<unknown>) => work(tx)),
  };
  const risk = {
    thresholds: async () => THRESHOLDS,
    criticalCategories: async () => CRITICAL,
  };
  const config = { get: async () => CLASSIFIER };
  const classifier = {
    classify: jest.fn(async () => ({
      result: options.classify
        ? {
            scores: { hate: 0.1 },
            score: options.classify.score,
            confident: options.classify.confident ?? false,
            category: options.classify.category ?? null,
          }
        : null,
      model: CLASSIFIER.model,
      error: options.error ?? null,
    })),
  };

  return {
    service: new ContentSafetyService(
      database as never,
      risk as never,
      config as never,
      classifier as never,
      { enqueue: jest.fn() } as never,
      {
        // The real rule, not a fixed answer: a stub that always says NORMAL cannot see an
        // escalation, which is exactly what the tests below are about.
        stamp: async ({ type, riskLevel, createdAt }: Record<string, never>) => ({
          priority: queuePriorityFor({ type, riskLevel: riskLevel ?? 'NONE' }),
          dueAt: queueDueBy({
            type,
            priority: queuePriorityFor({ type, riskLevel: riskLevel ?? 'NONE' }),
            createdAt: createdAt ?? new Date('2026-06-10T09:00:00Z'),
            slaMinutes: SYSTEM_CONFIG_DEFAULTS['reports.slaMinutes'],
            anonymousWorkingMinutes:
              SYSTEM_CONFIG_DEFAULTS['moderation.anonymousSlaWorkingMinutes'],
            workingHours: SYSTEM_CONFIG_DEFAULTS['moderation.workingHours'],
          }),
        }),
      } as never,
    ),
    writes,
    tx,
    database,
    classifier,
  };
};

describe('a job that should do nothing', () => {
  it('waits when the row is not there yet: the write has not committed', async () => {
    const { service } = build({ row: null });

    expect(await service.finalise(JOB, { lastAttempt: false })).toBe('pending');
  });

  it('waits when the row is older than the job, for the same reason', async () => {
    const { service } = build({ row: { scanVersion: 1 } });

    expect(await service.finalise(JOB, { lastAttempt: false })).toBe('pending');
  });

  it('drops a stale job: the content has been edited since', async () => {
    const { service, writes } = build({ row: { scanVersion: 3 } });

    expect(await service.finalise(JOB, { lastAttempt: false })).toBe('stale');
    expect(writes.update).toEqual([]);
  });

  it('drops a job for a scan that has already finished', async () => {
    const { service } = build({ row: { scanStatus: ContentScanStatus.COMPLETE } });

    expect(await service.finalise(JOB, { lastAttempt: false })).toBe('stale');
  });
});

describe('a classifier that answers', () => {
  it('publishes a clean post and completes the scan', async () => {
    const { service, writes } = build({ classify: { score: 0 } });

    expect(await service.finalise(JOB, { lastAttempt: false })).toBe('done');

    const update = (writes.update[0] as { data: Record<string, unknown> }).data;

    expect(update.scanStatus).toBe(ContentScanStatus.COMPLETE);
    expect(update.visibilityState).toBe(ContentVisibilityState.VISIBLE);
    expect(update.heldReason).toBeNull();
  });

  it("sends the post's images to the classifier, not only its words (§6.1)", async () => {
    const { service, classifier, database } = build({ classify: { score: 0 } });

    await service.finalise(JOB, { lastAttempt: false });

    // Looked up by the owner stamp `attach` writes, in render order.
    expect(database.media.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ownerId: 'target-1', type: 'IMAGE' }),
        orderBy: { position: 'asc' },
      }),
    );
    expect(classifier.classify).toHaveBeenCalledWith({
      fields: { title: 'a title', description: null },
      mediaKeys: ['uploads/photo-1.jpg'],
    });
  });

  /**
   * The item the inline scan opened, withdrawn by the full one. A weak lexicon hit the classifier
   * disagrees with ends up below the review threshold, and a reviewer should not be spending
   * attention on a flag about live, clean content that nobody reported.
   */
  it('withdraws its own queue item when the full verdict needs no human', async () => {
    const { service, writes } = build({
      row: { lexiconScore: 30, tier: ContentRiskTier.MEDIUM },
      classify: { score: 0 },
    });

    await service.finalise(JOB, { lastAttempt: false });

    expect(writes.queueWithdraw).toHaveLength(1);
    expect(writes.queueUpsert).toEqual([]);
  });

  it('holds a post the classifier is confident about, and opens an item for it', async () => {
    const { service, writes } = build({
      classify: { score: 93, confident: true, category: RiskCategory.SELF_HARM },
    });

    await service.finalise(JOB, { lastAttempt: false });

    const update = (writes.update[0] as { data: Record<string, unknown> }).data;

    expect(update.tier).toBe(ContentRiskTier.CRITICAL);
    expect(update.visibilityState).toBe(ContentVisibilityState.HELD);
    expect(writes.queueUpsert).toHaveLength(1);
  });

  /**
   * The bug this test exists for: the worker re-reads the content, not the title the write path
   * passed, so it has no summary — and an explicit null in the update blanked the line a reviewer
   * reads in the queue list.
   */
  it('does not blank the summary of an item it updates', async () => {
    const { service, writes } = build({
      classify: { score: 93, confident: true, category: RiskCategory.SELF_HARM },
    });

    await service.finalise(JOB, { lastAttempt: false });

    const upsert = writes.queueUpsert[0] as { update: Record<string, unknown> };

    expect('summary' in upsert.update).toBe(false);
  });

  it('writes a scan row naming the model, with degraded false', async () => {
    const { service, writes } = build({ classify: { score: 10 } });

    await service.finalise(JOB, { lastAttempt: false });

    const scan = (writes.scan[0] as { data: Record<string, unknown> }).data;

    expect(scan.classifierModel).toBe(CLASSIFIER.model);
    expect(scan.degraded).toBe(false);
  });

  it('never releases what a human held, however clean the words now are (§6.6)', async () => {
    const { service, writes } = build({
      row: {
        visibilityState: ContentVisibilityState.HELD,
        heldReason: HELD_REASON.STAFF_HIDE,
        reviewedById: 'staff-1',
      },
      classify: { score: 0 },
    });

    await service.finalise(JOB, { lastAttempt: false });

    const update = (writes.update[0] as { data: Record<string, unknown> }).data;

    expect(update.visibilityState).toBe(ContentVisibilityState.LIMITED);
  });
});

describe('a classifier that does not answer (§6.7)', () => {
  it('retries while attempts remain, by throwing', async () => {
    const { service } = build({ classify: null, error: 'timeout' });

    await expect(service.finalise(JOB, { lastAttempt: false })).rejects.toThrow('timeout');
  });

  it('records DEGRADED on the last attempt and publishes the clean post', async () => {
    const { service, writes } = build({ classify: null, error: 'timeout' });

    expect(await service.finalise(JOB, { lastAttempt: true })).toBe('degraded');

    const update = (writes.update[0] as { data: Record<string, unknown> }).data;
    const scan = (writes.scan[0] as { data: Record<string, unknown> }).data;

    expect(update.scanStatus).toBe(ContentScanStatus.DEGRADED);
    expect(update.visibilityState).toBe(ContentVisibilityState.VISIBLE);
    expect(scan.degraded).toBe(true);
    expect(scan.classifierError).toBe('timeout');
  });

  it('leaves a lexicon hold alone: never fail open', async () => {
    const { service, writes } = build({
      row: {
        tier: ContentRiskTier.HIGH,
        lexiconScore: 60,
        finalScore: 60,
        visibilityState: ContentVisibilityState.HELD,
        heldReason: HELD_REASON.AUTO_HIGH,
      },
      classify: null,
      error: 'timeout',
    });

    await service.finalise(JOB, { lastAttempt: true });

    const update = (writes.update[0] as { data: Record<string, unknown> }).data;

    expect(update.visibilityState).toBe(ContentVisibilityState.HELD);
  });
});

describe('an edit that made the content worse (§7.1)', () => {
  const openSince = new Date('2026-06-10T09:00:00Z');

  it('raises the open item’s priority and brings its deadline forward', async () => {
    const { service, writes } = build({
      // Scored CRITICAL now, so the band is URGENT.
      row: { lexiconScore: 95, finalScore: 95, tier: ContentRiskTier.CRITICAL },
      classify: { score: 95, confident: true, category: RiskCategory.MODERN_SLAVERY },
      openItem: { priority: 'NORMAL', createdAt: openSince },
    });

    await service.finalise(JOB, { lastAttempt: false });

    const update = (writes.queueUpsert[0] as { update: Record<string, unknown> }).update;

    // Without this the item keeps the NORMAL band it was created with and stays where it was in a
    // queue ordered by urgency — the one place a reviewer would never think to look for it.
    expect(update.priority).toBe('URGENT');
    // Recomputed from the item's **original** creation time, so a raise can only bring the
    // deadline forward. An escalation must not buy the item more time.
    expect(new Date(update.dueAt as string).getTime()).toBeLessThanOrEqual(
      openSince.getTime() + 60 * 60_000,
    );
  });

  it('leaves an item alone when the new verdict is no worse', async () => {
    const { service, writes } = build({
      row: { lexiconScore: 95, finalScore: 95, tier: ContentRiskTier.CRITICAL },
      classify: { score: 95, confident: true, category: RiskCategory.MODERN_SLAVERY },
      openItem: { priority: 'URGENT', createdAt: openSince },
    });

    await service.finalise(JOB, { lastAttempt: false });

    const update = (writes.queueUpsert[0] as { update: Record<string, unknown> }).update;

    // Only ever raises. A reviewer who has been told something is urgent must not see it quietly
    // demoted, and re-stamping the same band would reset the clock they are working to.
    expect(update.priority).toBeUndefined();
    expect(update.dueAt).toBeUndefined();
  });
});
