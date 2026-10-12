import { ContentRiskTier, ContentVisibilityState, RiskCategory } from '@prisma/client';
import {
  ClassifierResult,
  HELD_REASON,
  needsReview,
  scoreOf,
  stateFor,
  tierOf,
  TierThresholds,
} from '../safety-scoring';

/** The defaults from `safety.tierThresholds`. */
const THRESHOLDS: TierThresholds = { low: 1, medium: 30, high: 55, critical: 90 };
const CRITICAL = [
  'SELF_HARM',
  'DOMESTIC_ABUSE',
  'EXPLOITATION',
  'MODERN_SLAVERY',
  'DEPORTATION_RISK',
];

const classifier = (score: number, extra: Partial<ClassifierResult> = {}): ClassifierResult => ({
  scores: {},
  score,
  confident: false,
  category: null,
  ...extra,
});

const score = (input: Partial<Parameters<typeof scoreOf>[0]>) =>
  scoreOf({
    lexiconScore: 0,
    lexiconCategory: null,
    lexiconCriticalHit: false,
    classifier: null,
    thresholds: THRESHOLDS,
    criticalCategories: CRITICAL,
    weight: 0.6,
    ...input,
  });

describe('the tier a score falls in (§6.3)', () => {
  it.each([
    [0, ContentRiskTier.CLEAN],
    [1, ContentRiskTier.LOW],
    [29, ContentRiskTier.LOW],
    [30, ContentRiskTier.MEDIUM],
    [54, ContentRiskTier.MEDIUM],
    [55, ContentRiskTier.HIGH],
    [89, ContentRiskTier.HIGH],
  ])('%i is %s', (value, tier) => {
    expect(tierOf(value, null, THRESHOLDS, CRITICAL)).toBe(tier);
  });

  /**
   * The one boundary that is not arithmetic. A hundred-point scam listing is serious; it is not
   * somebody in danger, and sending it to the queue that handles self-harm would put fraud in
   * front of the people who answer safeguarding.
   */
  it('is CRITICAL over the top threshold only for a safeguarding category', () => {
    expect(tierOf(95, RiskCategory.SELF_HARM, THRESHOLDS, CRITICAL)).toBe(ContentRiskTier.CRITICAL);
    expect(tierOf(95, RiskCategory.SCAM, THRESHOLDS, CRITICAL)).toBe(ContentRiskTier.HIGH);
    expect(tierOf(95, null, THRESHOLDS, CRITICAL)).toBe(ContentRiskTier.HIGH);
  });
});

describe('the final score when a classifier answered (§6.3)', () => {
  it('blends the two at the configured weight', () => {
    // 0.6 × 80 + 0.4 × 30 = 60.
    expect(score({ lexiconScore: 30, classifier: classifier(80) }).finalScore).toBe(60);
  });

  it('is never diluted by a silent lexicon when the classifier is confident', () => {
    // The blend alone would be 0.6 × 93 = 56, which is HIGH but not what a 0.93 on self-harm means.
    const verdict = score({
      lexiconScore: 0,
      classifier: classifier(93, { confident: true, category: RiskCategory.SELF_HARM }),
    });

    expect(verdict.finalScore).toBe(93);
    expect(verdict.tier).toBe(ContentRiskTier.CRITICAL);
  });

  /**
   * A lexicon shouting at a silent classifier is usually a false positive — a term matching
   * innocently. "Usually" is not a reason to publish, so it lands on MEDIUM: limited, and a human
   * looks. The thing being asserted is that it is neither held nor published.
   */
  it('lands strong disagreement on MEDIUM rather than on either extreme', () => {
    const verdict = score({ lexiconScore: 70, classifier: classifier(2) });

    expect(verdict.finalScore).toBeGreaterThanOrEqual(THRESHOLDS.medium);
    expect(verdict.finalScore).toBeLessThan(THRESHOLDS.high);
    expect(verdict.tier).toBe(ContentRiskTier.MEDIUM);
  });

  it('escalates a safeguarding term that is severe on its own, whatever the classifier says', () => {
    const verdict = score({
      lexiconScore: 65,
      lexiconCategory: RiskCategory.MODERN_SLAVERY,
      lexiconCriticalHit: true,
      classifier: classifier(0),
    });

    expect(verdict.finalScore).toBe(THRESHOLDS.critical);
    expect(verdict.tier).toBe(ContentRiskTier.CRITICAL);
  });

  it('takes the heavier opinion for the category, and prefers safeguarding on a tie', () => {
    expect(
      score({
        lexiconScore: 50,
        lexiconCategory: RiskCategory.SCAM,
        classifier: classifier(50, { category: RiskCategory.SELF_HARM }),
      }).category,
    ).toBe(RiskCategory.SELF_HARM);

    expect(
      score({
        lexiconScore: 80,
        lexiconCategory: RiskCategory.SELF_HARM,
        classifier: classifier(10, { category: RiskCategory.SCAM }),
      }).category,
    ).toBe(RiskCategory.SELF_HARM);
  });
});

describe('the final score with no classifier (§6.7 degraded)', () => {
  it('is the lexicon score, and says it is degraded', () => {
    const verdict = score({ lexiconScore: 42, lexiconCategory: RiskCategory.SCAM });

    expect(verdict).toMatchObject({ finalScore: 42, tier: ContentRiskTier.MEDIUM, degraded: true });
  });

  /**
   * The deviation from §6.3 as written, which lists the safeguarding floor under "if classifier
   * available". Degraded means *less* information, and this floor is what decides whether a
   * trafficking disclosure opens a Guard case or lands in a content queue. A missing classifier is
   * not a reason to lean the other way.
   */
  it('still applies the safeguarding floor', () => {
    const verdict = score({
      lexiconScore: 65,
      lexiconCategory: RiskCategory.MODERN_SLAVERY,
      lexiconCriticalHit: true,
    });

    expect(verdict.tier).toBe(ContentRiskTier.CRITICAL);
    expect(verdict.degraded).toBe(true);
  });

  it('never fails open: a high lexicon hit is high', () => {
    expect(score({ lexiconScore: 60 }).tier).toBe(ContentRiskTier.HIGH);
  });

  it('caps at 100, so a page of matched terms is not a score of four hundred', () => {
    expect(score({ lexiconScore: 400 }).finalScore).toBe(100);
  });
});

describe('what a tier does to visibility (§6.5)', () => {
  it.each([
    [ContentRiskTier.CRITICAL, ContentVisibilityState.HELD, HELD_REASON.AUTO_CRITICAL],
    [ContentRiskTier.HIGH, ContentVisibilityState.HELD, HELD_REASON.AUTO_HIGH],
    [ContentRiskTier.MEDIUM, ContentVisibilityState.LIMITED, HELD_REASON.AUTO_MEDIUM],
  ])('%s is %s', (tier, state, heldReason) => {
    expect(stateFor({ tier, isAnonymous: false, classifierPending: false })).toEqual({
      state,
      heldReason,
    });
  });

  it.each([ContentRiskTier.CLEAN, ContentRiskTier.LOW])('%s is published', tier => {
    expect(stateFor({ tier, isAnonymous: false, classifierPending: false })).toEqual({
      state: ContentVisibilityState.VISIBLE,
      heldReason: null,
    });
  });

  /**
   * The provisional hold, and the reason it is conditional. §6.5 limits clean content until the
   * classifier answers so that nothing the classifier would hold reaches a feed first — which is
   * only a reason to wait while something is coming. With no classifier running, the same rule
   * would take every post out of every feed for ever.
   */
  it('holds clean content only while a classifier is actually coming', () => {
    expect(
      stateFor({ tier: ContentRiskTier.CLEAN, isAnonymous: false, classifierPending: true }),
    ).toEqual({ state: ContentVisibilityState.LIMITED, heldReason: HELD_REASON.PENDING_SCAN });
  });

  it('puts an anonymous post in the approval queue whatever it scored (§7.4)', () => {
    for (const tier of Object.values(ContentRiskTier)) {
      expect(stateFor({ tier, isAnonymous: true, classifierPending: false })).toEqual({
        state: ContentVisibilityState.PENDING_APPROVAL,
        heldReason: HELD_REASON.ANONYMOUS,
      });
    }
  });
});

describe('which tiers reach a human', () => {
  it.each([ContentRiskTier.MEDIUM, ContentRiskTier.HIGH, ContentRiskTier.CRITICAL])(
    '%s does',
    tier => expect(needsReview(tier)).toBe(true),
  );

  it.each([ContentRiskTier.CLEAN, ContentRiskTier.LOW])('%s does not', tier =>
    expect(needsReview(tier)).toBe(false),
  );
});
