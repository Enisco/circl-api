import { ModerationQueueType, ReportCasePriority, RiskLevel } from '@prisma/client';
import { WorkingHours } from '@/common';
import { addWorkingMinutes } from './working-hours';

/**
 * How urgent a queue item is, and when it is due (§5.9, §13.5).
 *
 * In `shared` rather than beside `report-priority.ts`, because the content scanner, the message
 * scanner, Guard and auto-guides all raise queue items and all of them live here or deeper. A
 * sibling of that file all the same, and separate from it because the inputs differ. A report's
 * priority comes from the reason a member gave; a queue item's comes from what the scanner made of
 * the content, because nobody reported it — the pipeline raised it.
 *
 * Pure, so the table in §13.5 can be asserted row by row rather than inferred from what the queue
 * happens to contain.
 */

const RANK: Record<RiskLevel, number> = {
  [RiskLevel.NONE]: 0,
  [RiskLevel.LOW]: 1,
  [RiskLevel.MEDIUM]: 2,
  [RiskLevel.HIGH]: 3,
  [RiskLevel.CRITICAL]: 4,
};

/** Ordering weight, so a sort by priority agrees with the badge beside it. */
export const PRIORITY_RANK: Record<ReportCasePriority, number> = {
  [ReportCasePriority.NORMAL]: 0,
  [ReportCasePriority.HIGH]: 1,
  [ReportCasePriority.URGENT]: 2,
};

export interface QueuePriorityInput {
  type: ModerationQueueType;
  riskLevel: RiskLevel;
}

export const queuePriorityFor = ({ type, riskLevel }: QueuePriorityInput): ReportCasePriority => {
  // A Guard item is a safeguarding concern about a person, and §6.5 only opens one at CRITICAL.
  // There is no non-urgent version of it.
  if (type === ModerationQueueType.GUARD_RISK) return ReportCasePriority.URGENT;

  if (RANK[riskLevel] >= RANK[RiskLevel.CRITICAL]) return ReportCasePriority.URGENT;
  if (RANK[riskLevel] >= RANK[RiskLevel.HIGH]) return ReportCasePriority.HIGH;

  return ReportCasePriority.NORMAL;
};

export interface QueueDueInput {
  type: ModerationQueueType;
  priority: ReportCasePriority;
  createdAt: Date;
  /** `reports.slaMinutes`, keyed by priority. */
  slaMinutes: Record<string, number>;
  /** `moderation.anonymousSlaWorkingMinutes`. */
  anonymousWorkingMinutes: number;
  workingHours: WorkingHours;
}

/**
 * When a reviewer should have reached it.
 *
 * Two clocks, and which one applies is the rule worth reading:
 *
 * - **Working hours** for an anonymous post that is not urgent (§13.5: four working hours). A
 *   wall clock would make everything posted on Friday evening overdue by Saturday lunchtime, so
 *   Monday opens on a queue that is entirely red and the colour stops carrying information.
 * - **Wall clock** for everything else, and for an *urgent* anonymous post regardless (§13.5 is
 *   explicit: CRITICAL is one hour, wall clock). Urgency that waits for opening time is not
 *   urgency, and the whole point of the band is that somebody is in danger now.
 */
export const queueDueBy = (input: QueueDueInput): Date => {
  const wallClock = (minutes: number) => new Date(input.createdAt.getTime() + minutes * 60_000);

  if (
    input.type === ModerationQueueType.ANONYMOUS_POST &&
    input.priority !== ReportCasePriority.URGENT
  ) {
    return addWorkingMinutes(input.createdAt, input.anonymousWorkingMinutes, input.workingHours);
  }

  return wallClock(input.slaMinutes[input.priority] ?? 0);
};

/**
 * The higher of two priorities.
 *
 * Escalation only ever raises (§7.1). A case that was urgent does not become ordinary because the
 * fourth person to report it picked a milder reason, and a post edited into something critical does
 * not keep the NORMAL band it was created with — a reviewer who has been told something is urgent
 * should never see it quietly demoted under them.
 *
 * Defined here rather than in `report-priority.ts`, which now re-exports it: cases and queue items
 * apply the same rule to the same enum, and two implementations of "pick the higher one" is how
 * they would eventually disagree about which is higher.
 */
export const raisedTo = (
  current: ReportCasePriority,
  next: ReportCasePriority,
): ReportCasePriority => (PRIORITY_RANK[next] > PRIORITY_RANK[current] ? next : current);
