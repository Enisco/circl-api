import { ContentRiskTier, ReportCasePriority, ReportReason } from '@prisma/client';
import { SYSTEM_CONFIG_DEFAULTS } from '@/common';
import { dueBy, priorityFor, raisedTo } from '../report-priority';

/**
 * §7.1's priority rules, which decide how long a reported post waits.
 *
 * Worth testing exhaustively because the two halves pull against each other: the reason is what a
 * member says is wrong and the tier is what the scanner found, and the rules only let the second
 * promote the first for three specific reasons. Get it wrong one way and everything is urgent; the
 * other way and a scam sits in the queue overnight.
 */
const SLA = SYSTEM_CONFIG_DEFAULTS['reports.slaMinutes'];

describe('priorityFor', () => {
  it('makes a safeguarding report urgent whatever the content scored', () => {
    expect(priorityFor(ReportReason.SAFETY_CONCERN, ContentRiskTier.CLEAN)).toBe(
      ReportCasePriority.URGENT,
    );
    expect(priorityFor(ReportReason.SCAM, ContentRiskTier.CLEAN)).toBe(ReportCasePriority.URGENT);
  });

  it('makes anything the scanner calls serious HIGH, whatever the reason given', () => {
    expect(priorityFor(ReportReason.SPAM, ContentRiskTier.HIGH)).toBe(ReportCasePriority.HIGH);
    expect(priorityFor(ReportReason.OTHER, ContentRiskTier.CRITICAL)).toBe(ReportCasePriority.HIGH);
  });

  it('promotes the three serious chips only when the scanner agrees', () => {
    for (const reason of [
      ReportReason.HATE_SPEECH,
      ReportReason.NUDITY,
      ReportReason.ILLEGAL_ITEM,
    ]) {
      expect(priorityFor(reason, ContentRiskTier.MEDIUM)).toBe(ReportCasePriority.HIGH);
      // On their own they are the most-tapped chips on the sheet. Taking them at face value
      // would make every report HIGH, and a queue where everything is urgent has no order.
      expect(priorityFor(reason, ContentRiskTier.LOW)).toBe(ReportCasePriority.NORMAL);
      expect(priorityFor(reason, ContentRiskTier.CLEAN)).toBe(ReportCasePriority.NORMAL);
    }
  });

  it('leaves an ordinary complaint about ordinary content alone', () => {
    expect(priorityFor(ReportReason.SPAM, ContentRiskTier.MEDIUM)).toBe(ReportCasePriority.NORMAL);
    expect(priorityFor(ReportReason.IMPERSONATION, ContentRiskTier.CLEAN)).toBe(
      ReportCasePriority.NORMAL,
    );
  });
});

describe('raisedTo', () => {
  it('only ever raises', () => {
    expect(raisedTo(ReportCasePriority.NORMAL, ReportCasePriority.URGENT)).toBe(
      ReportCasePriority.URGENT,
    );
    // The fourth person to report something picking a milder reason does not make it ordinary,
    // and a reviewer told it was urgent should not have it demoted under them.
    expect(raisedTo(ReportCasePriority.URGENT, ReportCasePriority.NORMAL)).toBe(
      ReportCasePriority.URGENT,
    );
    expect(raisedTo(ReportCasePriority.HIGH, ReportCasePriority.HIGH)).toBe(
      ReportCasePriority.HIGH,
    );
  });
});

describe('dueBy', () => {
  it('is wall clock from the first report, per the configured SLA', () => {
    const first = new Date('2026-10-11T23:30:00.000Z');

    expect(dueBy(first, ReportCasePriority.URGENT, SLA).toISOString()).toBe(
      '2026-10-12T00:30:00.000Z',
    );
    expect(dueBy(first, ReportCasePriority.HIGH, SLA).toISOString()).toBe(
      '2026-10-12T03:30:00.000Z',
    );
    expect(dueBy(first, ReportCasePriority.NORMAL, SLA).toISOString()).toBe(
      '2026-10-12T23:30:00.000Z',
    );
  });

  it('counts from the first report, not from the latest one', () => {
    // Otherwise a target somebody reports every few hours never comes due, which is exactly
    // backwards: more reports should mean sooner, never later.
    const first = new Date('2026-10-11T09:00:00.000Z');

    expect(dueBy(first, ReportCasePriority.URGENT, SLA).getTime()).toBeLessThan(
      new Date('2026-10-11T11:00:00.000Z').getTime(),
    );
  });
});
