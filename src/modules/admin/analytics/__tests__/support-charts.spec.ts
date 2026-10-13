import { DisputeReason, DisputeState, SupportThreadState, SupportThreadType } from '@prisma/client';
import { OPEN_THREAD_STATES, SupportAnalytics } from '../support.analytics';
import { DONE_SUPPORT_STATES, OPEN_SUPPORT_STATES } from '../../dtos/admin-support.dto';

/**
 * The Support tab's band lists, held against the enums they claim to cover (§5.25).
 *
 * The same reason the Trust & Safety tab has this spec: a chart that declares its own rows is a
 * list of enum values written out by hand, and the failure mode is silent. A sixth thread type
 * appears in the data and the chart simply does not have a bar for it — no error, no empty row,
 * just a total that is quietly short. Nothing in a green test run says so, because the test was
 * written against the five that existed.
 *
 * The other half is the one judgement on this tab that is not arithmetic: which states count as
 * "still somebody's work". `workloadPerAgent` divides the open queue by that line, and the inbox
 * filters its default tab by it — so the two have to agree, and this asserts that they do rather
 * than leaving two lists in two files to drift.
 */
describe('support chart bands', () => {
  it('counts a thread as open in the same states the inbox does', () => {
    // One rule, two files: the analytics list and the inbox's default filter. A thread the inbox
    // shows as work and the chart does not count is a column nobody can reconcile.
    expect([...OPEN_THREAD_STATES].sort()).toEqual([...OPEN_SUPPORT_STATES].sort());
  });

  it('splits every state into open or done, so a new one cannot fall between them', () => {
    for (const state of Object.values(SupportThreadState)) {
      const open = OPEN_THREAD_STATES.includes(state);
      const done = DONE_SUPPORT_STATES.includes(state);

      expect(open !== done).toBe(true);
    }
  });

  it('treats a resolved thread as finished, which is what makes the two charts agree', () => {
    // `openedResolved` counts a thread as resolved from `resolved_at`, and `workloadPerAgent`
    // counts it as open from its state. If RESOLVED were in the open list, one thread would be
    // both settled and outstanding on the same tab.
    expect(OPEN_THREAD_STATES).not.toContain(SupportThreadState.RESOLVED);
    expect(OPEN_THREAD_STATES).not.toContain(SupportThreadState.CLOSED);
  });

  it('declares every thread type, so `threadsByType` cannot be quietly short', () => {
    // The chart orders and labels from `Object.values(SupportThreadType)`, so this asserts the
    // enum itself has not grown past what the tab was reasoned about with — five types, one of
    // which is the one that must never be excluded from an aggregate by accident.
    expect(Object.values(SupportThreadType).sort()).toEqual([
      'DEAL_PROBLEM',
      'DISPUTE',
      'GUARD',
      'MANAGED',
      'SUPPORT',
    ]);
  });

  it('keeps GUARD in the type list, because an aggregate is not a readable thread', () => {
    // Deliberate, and the one place on this surface where `GUARD` is not filtered out: §5.15 hides
    // the thread from anybody without `guard:read`, and this tab reports how many there were.
    // "Disclosures were 4% of the week" is a staffing number; it names nobody.
    expect(Object.values(SupportThreadType)).toContain(SupportThreadType.GUARD);
  });

  it('declares every dispute reason and state for the matrix', () => {
    // `disputesByReasonOutcome` builds its rows and columns from both enums, and the columns
    // deliberately include the two that are not outcomes yet — a recent range with OPEN dropped
    // reads as though every dispute had been settled.
    expect(Object.values(DisputeReason).length).toBeGreaterThan(0);
    expect(Object.values(DisputeState)).toContain(DisputeState.OPEN);
    expect(Object.values(DisputeState)).toContain(DisputeState.IN_REVIEW);
  });

  it('says what every one of its filters reaches', () => {
    // §5.25's rule: the same filter bar serves five charts over two tables, so a filter that
    // reaches one and not another has to say so in the payload rather than leaving somebody to
    // infer it from a count that did not move.
    expect(Object.keys(SupportAnalytics.FILTER_SEMANTICS).sort()).toEqual([
      'assigneeIds',
      'memberFilters',
      'threadTypes',
    ]);

    for (const text of Object.values(SupportAnalytics.FILTER_SEMANTICS)) {
      expect(text.length).toBeGreaterThan(20);
      // The old text said each filter "reaches nothing until support threads exist". They all
      // reach something now, and a semantics string left behind is worse than none.
      expect(text).not.toContain('until support threads exist');
    }
  });
});
