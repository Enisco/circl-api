import { ContentRiskTier, ContentVisibilityState, RiskCategory } from '@prisma/client';

/** The thresholds from `safety.tierThresholds`. */
export interface TierThresholds {
  low: number;
  medium: number;
  high: number;
  critical: number;
}

/** What the classifier said, when it said anything (§6.3). */
export interface ClassifierResult {
  /** `category_scores` as returned, 0–1 per category. */
  scores: Record<string, number>;
  /** 0–100, after the per-category multipliers. */
  score: number;
  /** Whether any single category was confident on its own. */
  confident: boolean;
  category: RiskCategory | null;
}

export interface ScoreInput {
  /** Sum of matched term weights, capped at 100. */
  lexiconScore: number;
  /** The heaviest category the lexicon matched, or null. */
  lexiconCategory: RiskCategory | null;
  /** Whether a matched term was itself severe enough to escalate on its own (§6.3). */
  lexiconCriticalHit: boolean;
  classifier: ClassifierResult | null;
  thresholds: TierThresholds;
  criticalCategories: string[];
  /** `safety.classifier.weight`, the classifier's share of the blend. */
  weight: number;
}

export interface Verdict {
  finalScore: number;
  tier: ContentRiskTier;
  category: RiskCategory | null;
  /** True when the classifier did not answer, so the verdict stands on the lexicon alone. */
  degraded: boolean;
}

/** 0–100, both ends. */
const clamp = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

/**
 * The final score (§6.3).
 *
 * Four rules, and each is there because the simple blend gets a specific case wrong:
 *
 * 1. **A confident classifier is never diluted by a silent lexicon.** A lexicon is a list of
 *    phrases somebody thought of; the classifier reading 0.93 on self-harm in words nobody
 *    listed is the case the lexicon cannot cover, and `0.6 × 93` is not high enough to hold.
 * 2. **Strong disagreement lands on MEDIUM, not on "published".** A high lexicon score with a
 *    near-silent classifier is usually a false positive — but "usually" is not a reason to
 *    publish, so it is limited and a human looks.
 * 3. **Safeguarding leans to escalation.** A single term heavy enough to be a high score on its
 *    own escalates whatever anything else says.
 * 4. **Degraded never fails open.** With no classifier the lexicon verdict stands in full: a high
 *    lexicon hit is held, not published pending a scan that is not coming.
 */
export const scoreOf = (input: ScoreInput): Verdict => {
  const lexicon = clamp(input.lexiconScore);
  const { thresholds, classifier } = input;

  if (!classifier) {
    // `F = L`, plus rule 3. §6.3 lists the safeguarding floor under "if classifier available",
    // and applying it only there is the wrong way round: degraded means *less* information, and
    // the floor is what decides whether a trafficking disclosure opens a Guard case or lands in a
    // content queue. The rule exists because safeguarding leans to escalation; a missing
    // classifier is not a reason to lean the other way.
    const floored = input.lexiconCriticalHit ? Math.max(lexicon, thresholds.critical) : lexicon;

    return {
      finalScore: floored,
      tier: tierOf(floored, input.lexiconCategory, thresholds, input.criticalCategories),
      category: input.lexiconCategory,
      degraded: true,
    };
  }

  let score = clamp(input.weight * classifier.score + (1 - input.weight) * lexicon);

  // 1. A confident classifier sets the floor.
  if (classifier.confident) score = Math.max(score, clamp(classifier.score));

  // 2. Strong disagreement: the lexicon shouting, the classifier silent.
  if (lexicon >= thresholds.high && classifier.score < 20) {
    score = Math.max(Math.min(score, thresholds.high - 1), thresholds.medium);
  }

  // 3. A safeguarding term that is severe on its own.
  if (input.lexiconCriticalHit) score = Math.max(score, thresholds.critical);

  const category = categoryOf(input, classifier);

  return {
    finalScore: score,
    tier: tierOf(score, category, thresholds, input.criticalCategories),
    category,
    degraded: false,
  };
};

/**
 * The tier a score falls in (§6.3).
 *
 * `CRITICAL` is the one that is not purely numeric: a score over the top threshold is critical
 * **only** if the category is one of the safeguarding ones, and HIGH otherwise. A hundred-point
 * scam listing is serious; it is not somebody in danger, and treating the two the same would put
 * fraud in front of the people who handle self-harm.
 */
export const tierOf = (
  score: number,
  category: RiskCategory | null,
  thresholds: TierThresholds,
  criticalCategories: string[],
): ContentRiskTier => {
  if (score >= thresholds.critical) {
    return category && criticalCategories.includes(category)
      ? ContentRiskTier.CRITICAL
      : ContentRiskTier.HIGH;
  }

  if (score >= thresholds.high) return ContentRiskTier.HIGH;
  if (score >= thresholds.medium) return ContentRiskTier.MEDIUM;
  if (score >= thresholds.low) return ContentRiskTier.LOW;

  return ContentRiskTier.CLEAN;
};

/**
 * The category, which is the heavier of the two opinions (§6.4).
 *
 * Ties go to a safeguarding category, for the same reason the tier rule above exists: the cost of
 * reading a scam as self-harm is a reviewer's minute, and the cost of the reverse is somebody in
 * trouble waiting in a fraud queue.
 */
const categoryOf = (input: ScoreInput, classifier: ClassifierResult): RiskCategory | null => {
  const { lexiconCategory, criticalCategories } = input;

  if (!classifier.category) return lexiconCategory;
  if (!lexiconCategory) return classifier.category;

  const lexiconIsCritical = criticalCategories.includes(lexiconCategory);
  const classifierIsCritical = criticalCategories.includes(classifier.category);

  if (lexiconIsCritical !== classifierIsCritical) {
    return lexiconIsCritical ? lexiconCategory : classifier.category;
  }

  return clamp(input.lexiconScore) >= classifier.score ? lexiconCategory : classifier.category;
};

/** Why a piece of content is not visible, as `ContentSafety.heldReason` records it (§4.5). */
export const HELD_REASON = {
  AUTO_CRITICAL: 'AUTO_CRITICAL',
  AUTO_HIGH: 'AUTO_HIGH',
  AUTO_MEDIUM: 'AUTO_MEDIUM',
  /** An anonymous post, which waits for a human whatever it scored (§7.4). */
  ANONYMOUS: 'ANONYMOUS',
  /** Lexicon-clean, waiting for the classifier. Seconds, and only when one is coming (§6.5). */
  PENDING_SCAN: 'PENDING_SCAN',
  /** A staff member hid it (§5.7). */
  STAFF_HIDE: 'STAFF_HIDE',
  /**
   * A professional listing in a gated profession, waiting for a human to approve it (§2.9).
   *
   * A hold with nothing wrong behind it, which is why it has its own reason rather than borrowing
   * `ANONYMOUS`: the two produce the same visibility and need different queues, different copy to
   * the member, and different decisions from the reviewer.
   */
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
} as const;

export type HeldReason = (typeof HELD_REASON)[keyof typeof HELD_REASON];

export interface StateInput {
  tier: ContentRiskTier;
  /** §7.4: an anonymous post waits for approval whatever it scored. */
  isAnonymous: boolean;
  /**
   * §2.9: a listing in a gated profession waits for approval whatever it scored, for the same
   * reason and by the same mechanism — the content is fine, the question is whether this person
   * may offer this service at all, and only a person can answer that.
   */
  requiresApproval?: boolean;
  /**
   * Whether a classifier is actually going to answer.
   *
   * This is what makes the provisional hold honest. §6.5 limits lexicon-clean content until the
   * classifier completes, so that nothing the classifier would hold appears in a feed first — but
   * that is only a reason to wait while something is coming. With the classifier off (§6.7), the
   * lexicon verdict **is** the verdict, and holding every clean post for a scan that will never
   * run would take the whole platform out of its own feeds.
   */
  classifierPending: boolean;
}

export interface StateVerdict {
  state: ContentVisibilityState;
  heldReason: HeldReason | null;
}

/** What a tier does to visibility (§6.5). */
export const stateFor = (input: StateInput): StateVerdict => {
  if (input.isAnonymous) {
    return {
      state: ContentVisibilityState.PENDING_APPROVAL,
      heldReason: HELD_REASON.ANONYMOUS,
    };
  }

  if (input.requiresApproval) {
    return {
      state: ContentVisibilityState.PENDING_APPROVAL,
      heldReason: HELD_REASON.AWAITING_APPROVAL,
    };
  }

  switch (input.tier) {
    case ContentRiskTier.CRITICAL:
      return { state: ContentVisibilityState.HELD, heldReason: HELD_REASON.AUTO_CRITICAL };
    case ContentRiskTier.HIGH:
      return { state: ContentVisibilityState.HELD, heldReason: HELD_REASON.AUTO_HIGH };
    case ContentRiskTier.MEDIUM:
      return { state: ContentVisibilityState.LIMITED, heldReason: HELD_REASON.AUTO_MEDIUM };
    default:
      return input.classifierPending
        ? { state: ContentVisibilityState.LIMITED, heldReason: HELD_REASON.PENDING_SCAN }
        : { state: ContentVisibilityState.VISIBLE, heldReason: null };
  }
};

/**
 * What the platform does with a tier, in one word (§5.13's `PhraseTestResult.action`).
 *
 * Derived from `stateFor` rather than written as a second table beside it, so the answer staff are
 * shown in the phrase tester cannot drift from what the scanner would actually do. A tester that
 * says HOLD while the scanner publishes is worse than no tester: it is used to decide a term's
 * weight, so a wrong answer here is mis-tuned lexicon everywhere.
 *
 * `LOG` is the tier that is recorded and published — LOW crosses no threshold `needsReview` cares
 * about, so nothing is held and nobody is asked to look, but the signals are kept. That is what
 * makes a weight adjustable later: the evidence exists for matches that were never queued.
 */
export const actionFor = (
  tier: ContentRiskTier,
): 'PUBLISH' | 'LOG' | 'LIMIT' | 'HOLD' | 'HOLD_AND_GUARD' => {
  if (tier === ContentRiskTier.CRITICAL) return 'HOLD_AND_GUARD';

  // `classifierPending: false` — the question is what this tier *decides*, not whether a scan is
  // still running. With it true, every CLEAN tier would answer LIMIT, which is the provisional
  // hold rather than the verdict.
  const { state } = stateFor({
    tier,
    isAnonymous: false,
    requiresApproval: false,
    classifierPending: false,
  });

  if (state === ContentVisibilityState.HELD) return 'HOLD';
  if (state === ContentVisibilityState.LIMITED) return 'LIMIT';

  return tier === ContentRiskTier.CLEAN ? 'PUBLISH' : 'LOG';
};

/** Whether a tier earns a place in the flagged queue, and how urgently (§6.5). */
export const needsReview = (tier: ContentRiskTier): boolean =>
  tier === ContentRiskTier.MEDIUM ||
  tier === ContentRiskTier.HIGH ||
  tier === ContentRiskTier.CRITICAL;
