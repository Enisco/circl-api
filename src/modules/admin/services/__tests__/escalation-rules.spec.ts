import { EscalationState, ReportCasePriority, ContentRiskTier } from '@prisma/client';
import { priorityFor } from '@/modules/platform/moderation';
import { ALLOWED_FROM, OPEN_ESCALATION_STATES, REASON_FOR } from '../admin-escalation.service';
import { ESCALATION_CATEGORIES } from '../../dtos/admin-escalation.dto';

/**
 * §5.10's two rules with anything to get wrong: which transitions are allowed, and how urgent the
 * case an escalation files turns out to be.
 *
 * The second is the one worth a test rather than a reading. The spec says "priority from category:
 * SAFETY/SCAM → URGENT", and the implementation does not contain that sentence anywhere — it maps
 * the category onto a `ReportReason` and lets §7.1's existing priority table answer. That is the
 * right way round, because it means there is one definition of what is urgent; it is also exactly
 * the kind of indirection that is correct on the day it is written and quietly wrong after somebody
 * edits the other table. So this asserts the *outcome* the spec names, through both tables.
 */
describe('escalation state transitions', () => {
  it('lets an open escalation be acknowledged or resolved', () => {
    expect(ALLOWED_FROM[EscalationState.OPEN]).toEqual([
      EscalationState.ACKNOWLEDGED,
      EscalationState.RESOLVED,
    ]);
  });

  it('lets an acknowledged one only be resolved', () => {
    expect(ALLOWED_FROM[EscalationState.ACKNOWLEDGED]).toEqual([EscalationState.RESOLVED]);
  });

  it('makes RESOLVED final, including back to itself', () => {
    expect(ALLOWED_FROM[EscalationState.RESOLVED]).toEqual([]);
  });

  it('never allows a return to OPEN from anywhere', () => {
    for (const from of Object.values(EscalationState)) {
      expect(ALLOWED_FROM[from]).not.toContain(EscalationState.OPEN);
    }
  });

  it('has an answer for every state, so a new one cannot be silently un-transitionable', () => {
    expect(Object.keys(ALLOWED_FROM).sort()).toEqual([...Object.values(EscalationState)].sort());
  });

  /** The dashboard count and the list default are the same two states (§5.10). */
  it('counts both OPEN and ACKNOWLEDGED as still outstanding', () => {
    expect(OPEN_ESCALATION_STATES).toEqual([EscalationState.OPEN, EscalationState.ACKNOWLEDGED]);
    expect(OPEN_ESCALATION_STATES).not.toContain(EscalationState.RESOLVED);
  });
});

describe('how urgent the case an escalation files is', () => {
  /** On clean content, so the reason is doing the work rather than the scanner. */
  const priority = (category: keyof typeof REASON_FOR) =>
    priorityFor(REASON_FOR[category], ContentRiskTier.CLEAN);

  it('SAFETY and SCAM are URGENT whatever the content scored', () => {
    expect(priority('SAFETY')).toBe(ReportCasePriority.URGENT);
    expect(priority('SCAM')).toBe(ReportCasePriority.URGENT);
  });

  it('and nothing else is, on clean content', () => {
    expect(priority('HARASSMENT')).toBe(ReportCasePriority.NORMAL);
    expect(priority('ENFORCEMENT_REQUEST')).toBe(ReportCasePriority.NORMAL);
    expect(priority('OTHER')).toBe(ReportCasePriority.NORMAL);
  });

  it('maps every category, so a new one cannot file a report with no reason', () => {
    for (const category of ESCALATION_CATEGORIES) {
      expect(REASON_FOR[category]).toBeDefined();
    }

    expect(Object.keys(REASON_FOR).sort()).toEqual([...ESCALATION_CATEGORIES].sort());
  });
});
