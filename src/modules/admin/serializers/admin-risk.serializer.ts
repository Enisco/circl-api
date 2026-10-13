import { ContentRiskTier, ContentScanStatus, RiskCategory, RiskLevel } from '@prisma/client';

/**
 * §5.9's `RiskView`: everything a reviewer needs to answer "why is this in front of me".
 *
 * The queue was serving `{ level, category, score, signals }` — four of the nine fields, under
 * three different names. The portal's risk panel is built to this shape, so it drew a tier of
 * `undefined` beside a score it could not place on the band it belonged to.
 *
 * The fields come from **two** places and that is the reason this serialiser exists rather than a
 * `select`: `level`, `score` and the matched phrases are denormalised onto the queue item when it
 * is raised (so a queue row can be drawn without a join), while the tier, the lexicon half of the
 * score, the classifier and the scan's status live on `ContentSafety`, which is the record of the
 * scan itself. Either alone is a partial answer.
 *
 * Null where there is no scan: a report about a member, or about a conversation, has no content to
 * have scanned. A zeroed `RiskView` would read as "scanned and clean".
 */
export interface RiskView {
  tier: ContentRiskTier;
  /** The legacy `RiskLevel`, kept because the queue and Guard both still band on it. */
  level: RiskLevel | null;
  finalScore: number;
  lexiconScore: number;
  category: RiskCategory | null;
  signals: unknown[];
  classifier: { model: string; flagged: boolean; scores: Record<string, number> } | null;
  scanStatus: ContentScanStatus;
}

/** What a queue row carries about risk on its own, before the scan is read. */
export interface QueueRiskSource {
  riskLevel: RiskLevel | null;
  riskCategory: RiskCategory | null;
  riskScore: number | null;
  riskSignals: unknown;
}

/** The scan, as much of it as a risk view needs. */
export interface SafetySource {
  tier: ContentRiskTier;
  finalScore: number;
  lexiconScore: number;
  lexiconSignals: unknown;
  classifierScores: unknown;
  classifierFlagged: boolean | null;
  category: RiskCategory | null;
  scanStatus: ContentScanStatus;
}

/**
 * The scan and the queue item's own copy, merged.
 *
 * The scan wins on everything it holds, because it is the record: the queue item's numbers were
 * copied from it when the item was raised and a re-scan since then would have moved them. The
 * item's `signals` are used only where the scan has none of its own, which happens for the
 * message escalations (§6.8.1) that are raised from a signal rather than from a stored scan.
 */
export const toRiskView = (
  queue: QueueRiskSource | null,
  safety: SafetySource | null,
): RiskView | null => {
  if (!safety) {
    // No scan. For a queue item that still carries its own numbers — a Guard risk item, a message
    // escalation — the level and the phrases are all there is, and saying so beats withholding
    // the only evidence the reviewer has.
    if (!queue || (queue.riskScore === null && !asArray(queue.riskSignals).length)) return null;

    return {
      tier: ContentRiskTier.CLEAN,
      level: queue.riskLevel,
      finalScore: queue.riskScore ?? 0,
      lexiconScore: queue.riskScore ?? 0,
      category: queue.riskCategory,
      signals: asArray(queue.riskSignals),
      classifier: null,
      // Not `COMPLETE`: nothing was scanned, and claiming a complete scan of content that has no
      // safety row is the kind of small lie somebody builds a filter on.
      scanStatus: ContentScanStatus.PENDING,
    };
  }

  const scores = asRecord(safety.classifierScores);

  return {
    tier: safety.tier,
    level: queue?.riskLevel ?? null,
    finalScore: safety.finalScore,
    lexiconScore: safety.lexiconScore,
    category: safety.category ?? queue?.riskCategory ?? null,
    signals: asArray(safety.lexiconSignals).length
      ? asArray(safety.lexiconSignals)
      : asArray(queue?.riskSignals),
    // Null rather than a flagged:false stand-in where the classifier never ran — "the model said
    // nothing" and "there was no model" are different facts, and only one of them is evidence.
    classifier:
      safety.classifierFlagged === null && !scores
        ? null
        : {
            model: 'openai-moderation',
            flagged: safety.classifierFlagged ?? false,
            scores: scores ?? {},
          },
    scanStatus: safety.scanStatus,
  };
};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const asRecord = (value: unknown): Record<string, number> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, number>)
    : null;
