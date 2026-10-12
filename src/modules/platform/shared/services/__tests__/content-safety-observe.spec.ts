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
import { SCANNABLE_TARGETS } from '../content-source';

/**
 * OBSERVE mode, which is how a private message is scanned (§6.8).
 *
 * Every assertion here is about something **not** happening, which is why it is a unit test: the
 * e2e suite can see that a message was delivered and unmarked, but not that no column was
 * mirrored, no worker pass was queued and no row was left waiting for an answer that is never
 * coming. The last of those is the one that bites later — a row stuck at PENDING is swept, and a
 * message has nothing for the sweep to re-read.
 */
const THRESHOLDS = SYSTEM_CONFIG_DEFAULTS['safety.tierThresholds'];
const CRITICAL = SYSTEM_CONFIG_DEFAULTS['safety.criticalCategories'];
/** Enabled, so "nothing is coming" cannot be an accident of the classifier being switched off. */
const CLASSIFIER = { ...SYSTEM_CONFIG_DEFAULTS['safety.classifier'], enabled: true };

const INPUT = {
  targetType: ReportTargetType.MESSAGE,
  targetId: 'message-1',
  authorId: 'sender-1',
  fields: { body: 'the words of a private message' },
  trigger: ContentScanTrigger.CREATE,
  mode: 'OBSERVE' as const,
};

const build = (options: { lexiconScore?: number }) => {
  const writes: Record<string, unknown[]> = {
    upsert: [],
    scan: [],
    queueUpsert: [],
    mirror: [],
  };
  const tx = {
    contentSafety: {
      findUnique: jest.fn(async () => null),
      upsert: jest.fn(async (args: unknown) => {
        writes.upsert.push(args);

        return { id: 'safety-1' };
      }),
    },
    contentScan: {
      create: jest.fn(async (args: unknown) => {
        writes.scan.push(args);

        return {};
      }),
    },
    riskTermHit: { findMany: jest.fn(async () => []), createMany: jest.fn(async () => ({})) },
    riskTerm: { updateMany: jest.fn(async () => ({})) },
    moderationQueueItem: {
      upsert: jest.fn(async (args: unknown) => {
        writes.queueUpsert.push(args);

        return {};
      }),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    $executeRawUnsafe: jest.fn(async (...args: unknown[]) => {
      writes.mirror.push(args);

      return 1;
    }),
  };
  const score = options.lexiconScore ?? 0;
  const risk = {
    scanFields: jest.fn(async () => ({
      score,
      category: score ? RiskCategory.MODERN_SLAVERY : null,
      // What `scanFields` would report for a term this heavy in a safeguarding category, which
      // is what puts the §6.3 floor under the verdict.
      criticalHit: score >= THRESHOLDS.high,
      signals: score
        ? [
            {
              termId: 'term-1',
              category: RiskCategory.MODERN_SLAVERY,
              weight: score,
              field: 'body',
            },
          ]
        : [],
    })),
    thresholds: async () => THRESHOLDS,
    criticalCategories: async () => CRITICAL,
  };
  const enqueue = jest.fn();
  const service = new ContentSafetyService(
    { contentSafety: { findUnique: jest.fn(async () => null) } } as never,
    risk as never,
    { get: async () => CLASSIFIER } as never,
    { classify: jest.fn() } as never,
    { enqueue } as never,
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

  return { service, tx, writes, enqueue };
};

/** The answer a caller that ran the classifier itself hands over. */
const answered = (score: number) => ({
  result: { scores: { 'illicit/violent': 0.9 }, score, confident: true, category: null },
  model: CLASSIFIER.model,
  error: null,
});

describe('ContentSafetyService.assess in OBSERVE mode', () => {
  it('records the verdict and touches nothing else', async () => {
    const { service, tx, writes, enqueue } = build({ lexiconScore: 65 });

    const result = await service.assess(tx as never, { ...INPUT, classified: answered(70) });

    expect(writes.upsert).toHaveLength(1);
    expect(writes.scan).toHaveLength(1);
    // No mirrored column (a message has none to mirror), no queue item (the caller opens it, and
    // it knows who it is about), and no worker pass.
    expect(writes.mirror).toHaveLength(0);
    expect(writes.queueUpsert).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(tx.moderationQueueItem.upsert).not.toHaveBeenCalled();
    // CRITICAL by the safeguarding floor, and still visible: §6.8 never holds a message.
    expect(result.tier).toBe(ContentRiskTier.CRITICAL);
    expect(result.state).toBe(ContentVisibilityState.VISIBLE);
    expect(result.queuedScanVersion).toBeNull();
  });

  it('writes the verdict the caller acted on, not a lexicon-only one', async () => {
    const { service, tx, writes } = build({ lexiconScore: 0 });

    await service.assess(tx as never, { ...INPUT, classified: answered(80) });

    const row = (writes.upsert[0] as { create: Record<string, unknown> }).create;

    // Nothing matched a term, so a lexicon-only verdict would have been CLEAN and scored 0. The
    // classifier the caller already asked is what makes this a real verdict.
    expect(row.finalScore).toBeGreaterThan(0);
    expect(row.tier).not.toBe(ContentRiskTier.CLEAN);
  });

  it('finishes the row, because no worker pass is coming to finish it', async () => {
    const { service, tx, writes } = build({ lexiconScore: 65 });

    await service.assess(tx as never, { ...INPUT, classified: answered(40) });

    const row = (writes.upsert[0] as { create: Record<string, unknown> }).create;

    expect(row.scanStatus).toBe(ContentScanStatus.COMPLETE);
    expect((writes.scan[0] as { data: Record<string, unknown> }).data.degraded).toBe(false);
    expect((writes.scan[0] as { data: Record<string, unknown> }).data.classifierModel).toBe(
      CLASSIFIER.model,
    );
  });

  it('records a classifier that could not answer as degraded, never as pending', async () => {
    const { service, tx, writes } = build({ lexiconScore: 65 });

    await service.assess(tx as never, {
      ...INPUT,
      classified: { result: null, model: CLASSIFIER.model, error: 'timeout' },
    });

    const row = (writes.upsert[0] as { create: Record<string, unknown> }).create;

    // PENDING would mean "an answer is coming". None is, and `safety.rescan-degraded` would then
    // re-queue this row on every pass for ever.
    expect(row.scanStatus).toBe(ContentScanStatus.DEGRADED);
    expect((writes.scan[0] as { data: Record<string, unknown> }).data.classifierError).toBe(
      'timeout',
    );
  });

  it('leaves MESSAGE out of the targets the sweep may re-queue', () => {
    expect(SCANNABLE_TARGETS).not.toContain(ReportTargetType.MESSAGE);
    // And is not empty for some unrelated reason, which would make the line above pass for free.
    expect(SCANNABLE_TARGETS).toContain(ReportTargetType.REQUEST);
    expect(SCANNABLE_TARGETS.length).toBeGreaterThan(10);
  });
});
