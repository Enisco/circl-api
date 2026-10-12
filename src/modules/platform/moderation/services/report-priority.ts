import { ContentRiskTier, ReportCasePriority, ReportCaseState, ReportReason } from '@prisma/client';

/**
 * How urgent a report is, and when it is due (§7.1 steps 3 and 7).
 *
 * Kept apart from the service because it is the part with the rules in it: a pure function of the
 * reason somebody gave and what the scanner made of the content, which is the half worth testing
 * exhaustively and the half a reviewer will ask about.
 */

/** Reasons that are urgent whatever the content scored. */
const ALWAYS_URGENT: readonly ReportReason[] = [ReportReason.SAFETY_CONCERN, ReportReason.SCAM];

/**
 * Reasons that are urgent enough to jump the queue **if** the scanner agrees there is something
 * there. On their own they are the three most-tapped chips on the report sheet, so taking them at
 * face value would make every report HIGH and the word meaningless.
 */
const SERIOUS_WITH_SIGNAL: readonly ReportReason[] = [
  ReportReason.HATE_SPEECH,
  ReportReason.NUDITY,
  ReportReason.ILLEGAL_ITEM,
];

const TIER_RANK: Record<ContentRiskTier, number> = {
  [ContentRiskTier.CLEAN]: 0,
  [ContentRiskTier.LOW]: 1,
  [ContentRiskTier.MEDIUM]: 2,
  [ContentRiskTier.HIGH]: 3,
  [ContentRiskTier.CRITICAL]: 4,
};

export const priorityFor = (
  reasonCode: ReportReason,
  tier: ContentRiskTier,
): ReportCasePriority => {
  if (ALWAYS_URGENT.includes(reasonCode)) return ReportCasePriority.URGENT;

  const serious = TIER_RANK[tier] >= TIER_RANK[ContentRiskTier.HIGH];
  const corroborated =
    SERIOUS_WITH_SIGNAL.includes(reasonCode) &&
    TIER_RANK[tier] >= TIER_RANK[ContentRiskTier.MEDIUM];

  return serious || corroborated ? ReportCasePriority.HIGH : ReportCasePriority.NORMAL;
};

/**
 * Re-exported, not reimplemented (§7.1: "escalation only ever raises priority").
 *
 * The rule is the same for a queue item as for a case, over the same enum, so there is one copy —
 * in `platform/shared`, where the content scanner can reach it too.
 */
export { raisedTo } from '@/modules/platform/shared';

/**
 * Wall clock, deliberately (§7.1). Urgent is an hour at three in the morning as much as at three
 * in the afternoon — a business-hours clock would turn the weekend into a 60-hour SLA.
 */
export const dueBy = (
  firstReportedAt: Date,
  priority: ReportCasePriority,
  slaMinutes: Record<string, number>,
): Date => new Date(firstReportedAt.getTime() + (slaMinutes[priority] ?? 0) * 60_000);

/** The states a case is still work in (§7.2), which is also "one case per target" (§4.6). */
export const LIVE_CASE_STATES: readonly ReportCaseState[] = [
  ReportCaseState.OPEN,
  ReportCaseState.IN_REVIEW,
];

/** How long a dismissal stands before the same complaint is heard fresh (§7.1 step 5). */
export const DISMISSAL_STANDS_DAYS = 7;

/**
 * How many *new* people have to come forward after a dismissal before it is reopened as a new
 * case (§7.1 step 5). One is the person who just reported it; the rule asks for a second, so a
 * dismissal is not overturned by one member reporting the same thing twice from two accounts'
 * worth of persistence.
 */
export const REOPEN_AFTER_NEW_REPORTERS = 2;
