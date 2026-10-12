import {
  ContentRiskTier,
  ContentScanStatus,
  ContentScanTrigger,
  ContentVisibilityState,
  ReportTargetType,
} from '@prisma/client';
import { SYSTEM_CONFIG_DEFAULTS } from '@/common';
import { ContentSafetyService } from '../content-safety.service';
import { queueDueBy, queuePriorityFor } from '../queue-priority';
import { HELD_REASON } from '../safety-scoring';
import { isReachable } from '../content-visibility';

/**
 * §6.6's one guarantee, across both halves of the pipeline: **a re-scan never publishes what
 * somebody held.**
 *
 * The guarantee is already asserted in `content-safety-finalise.spec.ts`, but only against a row
 * built by hand — a row that still says `reviewedById: 'staff-1'` when the worker reads it. That
 * is not the row an edit leaves behind, and the two halves run in sequence: the author's edit runs
 * `assess` inline, and the worker pass reads whatever `assess` wrote. So the two are driven here
 * in that order, against the row the first one actually produces.
 */
const THRESHOLDS = SYSTEM_CONFIG_DEFAULTS['safety.tierThresholds'];
const CRITICAL = SYSTEM_CONFIG_DEFAULTS['safety.criticalCategories'];
const CLASSIFIER = { ...SYSTEM_CONFIG_DEFAULTS['safety.classifier'], enabled: true };

const INPUT = {
  targetType: ReportTargetType.REQUEST,
  targetId: 'target-1',
  authorId: 'author-1',
  fields: { title: 'an edited title', description: 'words nothing objects to' },
  trigger: ContentScanTrigger.EDIT,
};

/** The row as it stands after a staff member hid the content (§5.7). */
const STAFF_HELD = {
  id: 'safety-1',
  targetType: ReportTargetType.REQUEST,
  targetId: 'target-1',
  authorId: 'author-1',
  tier: ContentRiskTier.CLEAN,
  visibilityState: ContentVisibilityState.HELD,
  finalScore: 0,
  lexiconScore: 0,
  lexiconSignals: [],
  category: null,
  scanStatus: ContentScanStatus.COMPLETE,
  scanVersion: 1,
  contentHash: 'the-hash-before-the-edit',
  heldReason: HELD_REASON.STAFF_HIDE,
  heldAt: new Date('2026-10-01T00:00:00Z'),
  limitedAt: null,
  reviewedAt: new Date('2026-10-01T00:00:00Z'),
  reviewedById: 'staff-1',
};

/** The inline half: what the author's edit writes. */
const inlinePass = async (existing: Record<string, unknown> | null) => {
  const writes: Record<string, unknown[]> = { upsert: [], mirror: [], queueUpsert: [] };
  const tx = {
    contentSafety: {
      findUnique: jest.fn(async () => existing),
      upsert: jest.fn(async (args: { create: unknown; update: unknown }) => {
        writes.upsert.push(args);

        return { id: 'safety-1' };
      }),
    },
    contentScan: { create: jest.fn(async () => ({})) },
    riskTermHit: { findMany: jest.fn(async () => []), createMany: jest.fn(async () => ({})) },
    riskTerm: { updateMany: jest.fn(async () => ({})) },
    moderationQueueItem: {
      upsert: jest.fn(async (args: unknown) => {
        writes.queueUpsert.push(args);

        return {};
      }),
      updateMany: jest.fn(async () => ({ count: 0 })),
      findUnique: jest.fn(async () => null),
    },
    media: { findMany: jest.fn(async () => []) },
    $executeRawUnsafe: jest.fn(async (...args: unknown[]) => {
      writes.mirror.push(args);

      return 1;
    }),
  };
  const risk = {
    // Clean: the edit removed whatever the words were.
    scanFields: jest.fn(async () => ({
      score: 0,
      category: null,
      criticalHit: false,
      signals: [],
    })),
    thresholds: async () => THRESHOLDS,
    criticalCategories: async () => CRITICAL,
  };
  const service = new ContentSafetyService(
    { contentSafety: { findUnique: jest.fn(async () => existing) }, media: tx.media } as never,
    risk as never,
    { get: async () => CLASSIFIER } as never,
    { classify: jest.fn() } as never,
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
          anonymousWorkingMinutes: SYSTEM_CONFIG_DEFAULTS['moderation.anonymousSlaWorkingMinutes'],
          workingHours: SYSTEM_CONFIG_DEFAULTS['moderation.workingHours'],
        }),
      }),
    } as never,
  );

  await service.assess(tx as never, INPUT);

  const call = writes.upsert[0] as { update: Record<string, unknown> };

  return { update: call.update, writes };
};

/** The worker half, reading the row the inline pass left. */
const workerPass = async (row: Record<string, unknown>) => {
  const writes: Record<string, unknown[]> = { update: [], mirror: [], queueWithdraw: [] };
  const tx = {
    contentSafety: {
      findUnique: jest.fn(async () => ({
        scanVersion: row.scanVersion,
        scanStatus: row.scanStatus,
      })),
      update: jest.fn(async (args: unknown) => {
        writes.update.push(args);

        return {};
      }),
    },
    contentScan: { create: jest.fn(async () => ({})) },
    moderationQueueItem: {
      upsert: jest.fn(async () => ({})),
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
    contentSafety: { findUnique: jest.fn(async () => row) },
    media: { findMany: jest.fn(async () => []) },
    $queryRawUnsafe: jest.fn(async () => [{ id: 'target-1', title: 'a title', description: null }]),
    $transaction: jest.fn(async (work: (client: unknown) => Promise<unknown>) => work(tx)),
  };
  const service = new ContentSafetyService(
    database as never,
    { thresholds: async () => THRESHOLDS, criticalCategories: async () => CRITICAL } as never,
    { get: async () => CLASSIFIER } as never,
    {
      classify: jest.fn(async () => ({
        result: { scores: { hate: 0.01 }, score: 0, confident: false, category: null },
        model: CLASSIFIER.model,
        error: null,
      })),
    } as never,
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
          anonymousWorkingMinutes: SYSTEM_CONFIG_DEFAULTS['moderation.anonymousSlaWorkingMinutes'],
          workingHours: SYSTEM_CONFIG_DEFAULTS['moderation.workingHours'],
        }),
      }),
    } as never,
  );

  await service.finalise(
    {
      targetType: ReportTargetType.REQUEST,
      targetId: 'target-1',
      scanVersion: row.scanVersion as number,
      trigger: ContentScanTrigger.EDIT,
    },
    { lastAttempt: false },
  );

  return { writes };
};

describe('an author editing content a staff member held (§6.6)', () => {
  it('softens the hold to LIMITED and keeps saying why it was held', async () => {
    const { update } = await inlinePass(STAFF_HELD);

    // LIMITED is what §6.6 allows an edit to do, and the existing finalise spec asserts it. The
    // reason is the part that was being thrown away: the upsert clears `reviewedById`, so if the
    // reason goes too, nothing downstream can tell this row from a mildly limited post.
    expect(update.visibilityState).toBe(ContentVisibilityState.LIMITED);
    expect(update.heldReason).toBe(HELD_REASON.STAFF_HIDE);
    expect(update.reviewedById).toBeNull();
  });

  it('does not publish it on the worker pass behind the edit', async () => {
    const { update } = await inlinePass(STAFF_HELD);
    // The row as the edit left it — not one built by hand, which is the whole point: the worker
    // reads this, and `reviewedById` has already been cleared by the line above.
    const row = { ...STAFF_HELD, ...update, scanStatus: ContentScanStatus.PENDING, scanVersion: 2 };

    const { writes } = await workerPass(row);
    const final = (writes.update[0] as { data: Record<string, unknown> }).data;

    expect(final.visibilityState).toBe(ContentVisibilityState.LIMITED);
    expect(isReachable(final.visibilityState as ContentVisibilityState)).toBe(true);
  });
});

describe('an author editing content a scanner held, with no human behind it', () => {
  it('is still published when the classifier disagrees with the lexicon', async () => {
    const { update } = await inlinePass({
      ...STAFF_HELD,
      heldReason: HELD_REASON.AUTO_HIGH,
      reviewedAt: null,
      reviewedById: null,
    });
    const row = { ...STAFF_HELD, ...update, scanStatus: ContentScanStatus.PENDING, scanVersion: 2 };

    const { writes } = await workerPass(row);
    const final = (writes.update[0] as { data: Record<string, unknown> }).data;

    // The counterweight to the two tests above: a lexicon hold the classifier overrules is meant
    // to be released, and protecting human decisions must not freeze scanner ones too.
    expect(final.visibilityState).toBe(ContentVisibilityState.VISIBLE);
  });
});

describe('an author editing content that was rejected (§6.6)', () => {
  it('does not turn a rejection back into live content', async () => {
    const rejected = {
      ...STAFF_HELD,
      visibilityState: ContentVisibilityState.REJECTED,
      heldReason: null,
    };

    const { update } = await inlinePass(rejected);

    expect(update.visibilityState).toBe(ContentVisibilityState.REJECTED);
  });
});
