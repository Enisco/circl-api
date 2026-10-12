import { ContentRiskTier, RiskCategory, ThreadKind } from '@prisma/client';

/**
 * Who a safeguarding hit in a private message is **about** (§6.8.1).
 *
 * The problem the table solves is that a scanner cannot tell somebody disclosing harm from
 * somebody threatening it. "He kept my passport" and "I'll keep your passport" match the same
 * phrase. So the rules default to the disclosing reading — the sender is the person who needs
 * help — and a **threat signal** from the classifier switches the subject to the recipient.
 *
 * `EXPLOITATION` is the exception in both columns: grooming and exploitative offers are aimed at
 * the other person, so the recipient is always the subject and the sender always gets an item of
 * their own.
 */
export type SubjectRole = 'SENDER' | 'RECIPIENT' | 'GROUP';

export type EscalationRule = 'DEFAULT' | 'THREAT_SIGNAL';

export interface EscalationInput {
  category: RiskCategory;
  tier: ContentRiskTier;
  /** A classifier score ≥ 0.5 in a threatening category (§6.8.1). */
  hasThreatSignal: boolean;
  /** `sexual/minors` ≥ 0.5, which carries a reporting duty and jumps the queue (§6.4). */
  hasMinorSignal: boolean;
  conversationKind: ThreadKind;
}

export interface Escalation {
  subjectRole: SubjectRole;
  rule: EscalationRule;
  /** A second item about the sender, where the table asks for one. */
  flagSender: boolean;
  /**
   * Whether a Guard case is opened for the subject.
   *
   * False in a group thread when the subject is "the recipient", because in a group that is not a
   * person: §6.8.1 leaves the choice to a reviewer, who opens a case for the right member.
   */
  openCase: boolean;
  priority: 'URGENT' | 'HIGH';
}

/**
 * The rule, rather than §6.8.1's table restated.
 *
 * Four of the five categories behave identically — sender by default, recipient with a threat
 * signal — and `EXPLOITATION` is the exception, so the code says "exploitation is aimed outward;
 * everything else reads as a disclosure". Listing the four as a constant would have been a second
 * place to maintain the same fact, and it would answer the wrong way for a category somebody adds
 * to `safety.criticalCategories` later: an unknown safeguarding category defaults to the
 * disclosing reading, which is the safe side to be wrong on.
 */
export const escalationFor = (input: EscalationInput): Escalation => {
  const isGroup = input.conversationKind === ThreadKind.GROUP;
  const exploitation = input.category === RiskCategory.EXPLOITATION;

  // Exploitation is aimed outward, always. Everything else reads as a disclosure until the
  // classifier says somebody is being threatened.
  const switched = !exploitation && input.hasThreatSignal;
  const subject: SubjectRole = exploitation || switched ? 'RECIPIENT' : 'SENDER';
  const resolved: SubjectRole = subject === 'RECIPIENT' && isGroup ? 'GROUP' : subject;

  return {
    subjectRole: resolved,
    rule: switched ? 'THREAT_SIGNAL' : 'DEFAULT',
    // The sender gets their own item when the hit reads as something they did: always for
    // exploitation, and for the rest only once a threat signal has moved the subject away.
    flagSender: exploitation || switched,
    openCase: resolved !== 'GROUP',
    priority:
      input.tier === ContentRiskTier.CRITICAL || (exploitation && input.hasMinorSignal)
        ? 'URGENT'
        : 'HIGH',
  };
};

/** Whether a category escalates at all, or is only ever stored as a signal (§6.8). */
export const escalates = (category: RiskCategory | null, criticalCategories: string[]): boolean =>
  !!category && criticalCategories.includes(category);

/** The two commercial categories a message scan watches besides the safeguarding ones (§6.8). */
export const MESSAGE_SCAM_CATEGORIES: RiskCategory[] = [
  RiskCategory.SCAM,
  RiskCategory.LANDLORD_FRAUD,
];

/** The classifier categories that count as a threat signal (§6.8.1). */
export const THREAT_SIGNAL_CATEGORIES = [
  'harassment/threatening',
  'violence',
  'violence/graphic',
  'illicit/violent',
];

/** §6.8.1: a score at or above this in a threatening category switches the subject. */
export const THREAT_SIGNAL_AT = 0.5;

/** The one action a message scan writes to the trail. Never with the message text (§6.8). */
export const MESSAGE_ESCALATED_ACTION = 'safety.message_escalated';
