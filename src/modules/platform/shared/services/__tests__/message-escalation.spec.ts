import { ContentRiskTier, RiskCategory, ThreadKind } from '@prisma/client';
import { SYSTEM_CONFIG_DEFAULTS } from '@/common';
import { escalates, escalationFor } from '../message-escalation';

const CRITICAL = SYSTEM_CONFIG_DEFAULTS['safety.criticalCategories'];

const call = (overrides: Partial<Parameters<typeof escalationFor>[0]> = {}) =>
  escalationFor({
    category: RiskCategory.SELF_HARM,
    tier: ContentRiskTier.HIGH,
    hasThreatSignal: false,
    hasMinorSignal: false,
    conversationKind: ThreadKind.DIRECT,
    ...overrides,
  });

/**
 * §6.8.1's table, as a test.
 *
 * The question it answers is the hard one in the whole feature: a scanner cannot tell somebody
 * disclosing harm from somebody threatening it, because "he kept my passport" and "I'll keep your
 * passport" match the same phrase. Reading it the wrong way round sends a Guard case to the person
 * doing the harming and nothing to the person it is happening to — so the default is the
 * disclosing reading, and only a classifier threat signal moves it.
 */
describe('who a safeguarding hit is about (§6.8.1)', () => {
  const disclosure = [
    RiskCategory.SELF_HARM,
    RiskCategory.DOMESTIC_ABUSE,
    RiskCategory.MODERN_SLAVERY,
    RiskCategory.DEPORTATION_RISK,
  ];

  it.each(disclosure)('%s is about the sender by default', category => {
    expect(call({ category })).toMatchObject({
      subjectRole: 'SENDER',
      rule: 'DEFAULT',
      flagSender: false,
    });
  });

  it.each(disclosure)('%s with a threat signal is about the recipient instead', category => {
    expect(call({ category, hasThreatSignal: true })).toMatchObject({
      subjectRole: 'RECIPIENT',
      rule: 'THREAT_SIGNAL',
      // And then the sender gets an item of their own, because now it reads as something they did.
      flagSender: true,
    });
  });

  it('is always about the recipient for exploitation, threat signal or not', () => {
    for (const hasThreatSignal of [false, true]) {
      expect(call({ category: RiskCategory.EXPLOITATION, hasThreatSignal })).toMatchObject({
        subjectRole: 'RECIPIENT',
        flagSender: true,
      });
    }
  });

  it('does not call exploitation a threat-signal rule: it was never the default reading', () => {
    expect(call({ category: RiskCategory.EXPLOITATION, hasThreatSignal: true }).rule).toBe(
      'DEFAULT',
    );
  });
});

describe('a group thread, where "the recipient" is not a person', () => {
  it('opens no case and says the subject is the group', () => {
    expect(
      call({
        category: RiskCategory.EXPLOITATION,
        conversationKind: ThreadKind.GROUP,
      }),
    ).toMatchObject({ subjectRole: 'GROUP', openCase: false });
  });

  it('still opens a case for a sender-subject hit, because that is one person', () => {
    expect(
      call({ category: RiskCategory.SELF_HARM, conversationKind: ThreadKind.GROUP }),
    ).toMatchObject({ subjectRole: 'SENDER', openCase: true });
  });
});

describe('how urgently', () => {
  it('is HIGH at the high tier', () => {
    expect(call().priority).toBe('HIGH');
  });

  it('is URGENT at the critical tier', () => {
    expect(call({ tier: ContentRiskTier.CRITICAL }).priority).toBe('URGENT');
  });

  /** The reporting duty in §6.4: a model half sure about a child is already past our threshold. */
  it('is URGENT for exploitation with a minor signal, whatever the tier', () => {
    expect(
      call({
        category: RiskCategory.EXPLOITATION,
        tier: ContentRiskTier.HIGH,
        hasMinorSignal: true,
      }).priority,
    ).toBe('URGENT');
  });

  it('is not made URGENT by a minor signal on another category', () => {
    expect(call({ category: RiskCategory.SELF_HARM, hasMinorSignal: true }).priority).toBe('HIGH');
  });
});

describe('which categories escalate at all (§6.8)', () => {
  it.each(CRITICAL)('%s does', category => {
    expect(escalates(category as RiskCategory, CRITICAL)).toBe(true);
  });

  it.each([RiskCategory.SCAM, RiskCategory.HATE, RiskCategory.OTHER])('%s does not', category => {
    expect(escalates(category, CRITICAL)).toBe(false);
  });

  it('nothing escalates without a category', () => {
    expect(escalates(null, CRITICAL)).toBe(false);
  });
});
