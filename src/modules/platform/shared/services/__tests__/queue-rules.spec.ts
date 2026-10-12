import {
  ContentVisibilityState,
  ModerationDecision,
  ModerationQueueState,
  ModerationQueueType,
  ReportCasePriority,
  ReportTargetType,
  RiskLevel,
} from '@prisma/client';
import { SYSTEM_CONFIG_DEFAULTS, WorkingHours } from '@/common';
import { allowedDecisionsFor } from '../allowed-decisions';
import { queueDueBy, queuePriorityFor } from '../queue-priority';

const HOURS = SYSTEM_CONFIG_DEFAULTS['moderation.workingHours'] as WorkingHours;
const SLA = SYSTEM_CONFIG_DEFAULTS['reports.slaMinutes'];
const ANON_MINUTES = SYSTEM_CONFIG_DEFAULTS['moderation.anonymousSlaWorkingMinutes'];

/** §13.5's table, row by row. */
describe('queuePriorityFor', () => {
  it.each([
    [RiskLevel.NONE, ReportCasePriority.NORMAL],
    [RiskLevel.LOW, ReportCasePriority.NORMAL],
    [RiskLevel.MEDIUM, ReportCasePriority.NORMAL],
    [RiskLevel.HIGH, ReportCasePriority.HIGH],
    [RiskLevel.CRITICAL, ReportCasePriority.URGENT],
  ])('an anonymous post at %s is %s', (riskLevel, expected) => {
    expect(queuePriorityFor({ type: ModerationQueueType.ANONYMOUS_POST, riskLevel })).toBe(
      expected,
    );
  });

  it('a Guard item is urgent whatever it scored, because §6.5 only opens one at CRITICAL', () => {
    expect(
      queuePriorityFor({ type: ModerationQueueType.GUARD_RISK, riskLevel: RiskLevel.NONE }),
    ).toBe(ReportCasePriority.URGENT);
  });

  it('flagged content follows the band', () => {
    expect(
      queuePriorityFor({ type: ModerationQueueType.FLAGGED_CONTENT, riskLevel: RiskLevel.HIGH }),
    ).toBe(ReportCasePriority.HIGH);
    expect(
      queuePriorityFor({ type: ModerationQueueType.FLAGGED_CONTENT, riskLevel: RiskLevel.MEDIUM }),
    ).toBe(ReportCasePriority.NORMAL);
  });
});

describe('queueDueBy', () => {
  const due = (type: ModerationQueueType, priority: ReportCasePriority, createdAt: string) =>
    queueDueBy({
      type,
      priority,
      createdAt: new Date(createdAt),
      slaMinutes: SLA,
      anonymousWorkingMinutes: ANON_MINUTES,
      workingHours: HOURS,
    }).toISOString();

  it('gives an anonymous post four working hours', () => {
    // Friday 21:00 London → Monday 13:00 London (12:00Z), not Saturday lunchtime.
    expect(
      due(ModerationQueueType.ANONYMOUS_POST, ReportCasePriority.NORMAL, '2026-06-12T20:00:00Z'),
    ).toBe('2026-06-15T12:00:00.000Z');
  });

  it('gives an URGENT anonymous post one hour on the wall clock', () => {
    // §13.5 is explicit. Urgency that waits for opening time is not urgency: somebody is in danger
    // now, and the queue has to say so at three in the morning.
    expect(
      due(ModerationQueueType.ANONYMOUS_POST, ReportCasePriority.URGENT, '2026-06-12T20:00:00Z'),
    ).toBe('2026-06-12T21:00:00.000Z');
  });

  it('gives everything else the wall clock for its band', () => {
    expect(
      due(ModerationQueueType.FLAGGED_CONTENT, ReportCasePriority.HIGH, '2026-06-12T20:00:00Z'),
    ).toBe('2026-06-13T00:00:00.000Z');
    expect(
      due(ModerationQueueType.GUARD_RISK, ReportCasePriority.URGENT, '2026-06-12T20:00:00Z'),
    ).toBe('2026-06-12T21:00:00.000Z');
  });

  it('falls back to now rather than to Invalid Date when a band has no configured SLA', () => {
    expect(
      queueDueBy({
        type: ModerationQueueType.FLAGGED_CONTENT,
        priority: ReportCasePriority.NORMAL,
        createdAt: new Date('2026-06-12T20:00:00Z'),
        slaMinutes: {},
        anonymousWorkingMinutes: ANON_MINUTES,
        workingHours: HOURS,
      }).toISOString(),
    ).toBe('2026-06-12T20:00:00.000Z');
  });
});

/** §5.9's table, and the distinction §6.6 cares about most. */
describe('allowedDecisionsFor', () => {
  const ask = (over: Partial<Parameters<typeof allowedDecisionsFor>[0]> = {}) =>
    allowedDecisionsFor({
      type: ModerationQueueType.FLAGGED_CONTENT,
      state: ModerationQueueState.PENDING,
      targetType: ReportTargetType.REQUEST,
      visibilityState: ContentVisibilityState.HELD,
      ...over,
    });

  it('offers APPROVE on held content and not RESTORE_REACH', () => {
    expect(ask()).toContain(ModerationDecision.APPROVE);
    expect(ask()).not.toContain(ModerationDecision.RESTORE_REACH);
  });

  it('offers RESTORE_REACH on limited content and not APPROVE', () => {
    const decisions = ask({ visibilityState: ContentVisibilityState.LIMITED });

    // The two are not synonyms. `APPROVE` publishes; `RESTORE_REACH` gives back distribution to
    // something already reachable. Offering both invites the wrong verb for what happened.
    expect(decisions).toContain(ModerationDecision.RESTORE_REACH);
    expect(decisions).not.toContain(ModerationDecision.APPROVE);
  });

  it('offers neither on content that is already visible', () => {
    const decisions = ask({ visibilityState: ContentVisibilityState.VISIBLE });

    expect(decisions).not.toContain(ModerationDecision.APPROVE);
    expect(decisions).not.toContain(ModerationDecision.RESTORE_REACH);
    // There is still something to do with it.
    expect(decisions).toContain(ModerationDecision.REMOVE_CONTENT);
  });

  it('never offers to remove a message, because §6.8 does not hide them', () => {
    const decisions = ask({ targetType: ReportTargetType.MESSAGE, visibilityState: null });

    expect(decisions).not.toContain(ModerationDecision.REMOVE_CONTENT);
    expect(decisions).not.toContain(ModerationDecision.APPROVE);
    expect(decisions).toEqual([
      ModerationDecision.NO_ACTION,
      ModerationDecision.WARN_AUTHOR,
      ModerationDecision.SUSPEND_AUTHOR,
      ModerationDecision.ESCALATE_GUARD,
    ]);
  });

  it('returns nothing for a decided item, so the portal renders history instead of buttons', () => {
    expect(ask({ state: ModerationQueueState.RESOLVED })).toEqual([]);
  });

  it('lets a Guard item about content still be published or removed', () => {
    const decisions = ask({
      type: ModerationQueueType.GUARD_RISK,
      visibilityState: ContentVisibilityState.HELD,
    });

    // Held content must always be able to leave the queue, rather than waiting on a safeguarding
    // conversation that may take days.
    expect(decisions).toContain(ModerationDecision.APPROVE);
    expect(decisions).toContain(ModerationDecision.REMOVE_CONTENT);
    expect(decisions).toContain(ModerationDecision.ESCALATE_GUARD);
  });

  it('offers a Guard item about a person nothing to do to content', () => {
    const decisions = ask({
      type: ModerationQueueType.GUARD_RISK,
      targetType: ReportTargetType.USER,
      visibilityState: null,
    });

    expect(decisions).toEqual([ModerationDecision.NO_ACTION, ModerationDecision.ESCALATE_GUARD]);
  });

  it('offers approve and reject on an anonymous post', () => {
    expect(ask({ type: ModerationQueueType.ANONYMOUS_POST })).toEqual([
      ModerationDecision.APPROVE,
      ModerationDecision.REJECT,
      ModerationDecision.ESCALATE_GUARD,
    ]);
  });

  it('delegates: a case, an appeal and a professional review carry no buttons of their own', () => {
    // Each has its own endpoint with its own rules and side effects. An empty list is what tells
    // the portal to send the reviewer there rather than drawing a button it cannot honour.
    expect(ask({ type: ModerationQueueType.REPORTED_CONTENT })).toEqual([]);
    expect(ask({ type: ModerationQueueType.APPEAL })).toEqual([]);
    expect(ask({ type: ModerationQueueType.PROFESSIONAL_REVIEW })).toEqual([]);
  });

  it('offers publish and reject on an auto-guide draft', () => {
    expect(ask({ type: ModerationQueueType.AUTO_GUIDE })).toEqual([
      ModerationDecision.APPROVE,
      ModerationDecision.REJECT,
    ]);
  });
});
