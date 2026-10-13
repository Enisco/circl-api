import {
  AppealState,
  ContentRiskTier,
  ModerationDecision,
  ModerationQueueType,
  ReportCasePriority,
  ReportCaseState,
  ReportState,
} from '@prisma/client';
import { CASE_DECISIONS } from '../../dtos/admin-report-case.dto';
import {
  APPEAL_OUTCOMES,
  CASE_STATES,
  DECISION_ORDER,
  FLAGGED_TIERS,
  FOLDED_DECISION,
  NOT_MODERATION,
  PRIORITIES,
} from '../safety.analytics';

/**
 * The band lists on the Trust & Safety tab, against the enums they claim to cover.
 *
 * Every one of these is a hand-written list of keys over a database enum, which is the shape that
 * goes wrong silently. `decisionMix` is the worked example: it was written when
 * `ModerationDecision` held no compound value, its comment said "there is nothing to fold", and
 * the enum later grew `REMOVE_AND_WARN`, `REMOVE_AND_SUSPEND` and `ESCALATE_GUARD`. Nothing broke.
 * Three bands simply started existing and no chart was counting them — a plausible bar chart that
 * dropped a fifth of the decisions.
 *
 * So these tests are not about the lists being *correct*; they are about the lists being
 * **complete against their enum**, which is the only part a reader cannot check by looking.
 */
describe('decisionMix bands', () => {
  /** What a case can actually be decided, once the compound decisions are folded. */
  const expected = new Set(CASE_DECISIONS.map(decision => FOLDED_DECISION[decision] ?? decision));

  it('covers every decision a report case can hold, and nothing it cannot', () => {
    expect([...DECISION_ORDER].sort()).toEqual([...expected].sort());
  });

  it('folds only the compound decisions', () => {
    expect(Object.keys(FOLDED_DECISION).sort()).toEqual(
      [ModerationDecision.REMOVE_AND_SUSPEND, ModerationDecision.REMOVE_AND_WARN].sort(),
    );
  });

  it('folds each of them onto a band that is itself charted', () => {
    for (const target of Object.values(FOLDED_DECISION)) {
      expect(DECISION_ORDER).toContain(target);
    }
  });

  it('names each band once', () => {
    expect([...new Set(DECISION_ORDER)]).toHaveLength(DECISION_ORDER.length);
  });
});

describe('the enums the filter bar crosses', () => {
  /**
   * `states` is declared over `ReportState` and three charts read a table carrying
   * `ReportCaseState`. The shared names are what may be applied there; anything else is a question
   * about reports that a case cannot answer.
   */
  it('CASE_STATES is exactly the intersection of the two state enums', () => {
    const shared = Object.values(ReportState).filter(state =>
      (Object.values(ReportCaseState) as string[]).includes(state),
    );

    expect([...CASE_STATES].sort()).toEqual(shared.sort());
  });

  it('FLAGGED_TIERS is every tier but the one that is not a flag', () => {
    expect([...FLAGGED_TIERS].sort()).toEqual(
      Object.values(ContentRiskTier)
        .filter(tier => tier !== ContentRiskTier.CLEAN)
        .sort(),
    );
  });

  it('timeToAction charts every priority a case can carry', () => {
    expect([...PRIORITIES].sort()).toEqual(Object.values(ReportCasePriority).sort());
  });
});

describe('appealOverturn', () => {
  it('counts only the appeals somebody answered', () => {
    expect([...APPEAL_OUTCOMES].sort()).toEqual(
      [AppealState.OVERTURNED, AppealState.UPHELD].sort(),
    );
  });

  /**
   * The direction matters more than the rule. Both would sit in the denominator and push the rate
   * down, and a number whose job is to catch a reviewer being wrong too often must not be
   * flattered by the appeals nobody answered.
   */
  it('and never a withdrawal or an open one, which have no outcome', () => {
    expect(APPEAL_OUTCOMES).not.toContain(AppealState.WITHDRAWN);
    expect(APPEAL_OUTCOMES).not.toContain(AppealState.OPEN);
    expect(APPEAL_OUTCOMES).not.toContain(AppealState.IN_REVIEW);
  });
});

describe('what this tab must never count', () => {
  /**
   * `PROFESSIONAL_REVIEW` shares the queue table and is not moderation work: nothing is wrong with
   * the listing and nobody is accused of anything. Three approved listings once put a 384-minute
   * median on the NORMAL time-to-action line.
   */
  it('names a queue type that exists, so the exclusion is not a typo that excludes nothing', () => {
    for (const type of NOT_MODERATION) {
      expect(Object.values(ModerationQueueType)).toContain(type);
    }
  });
});
