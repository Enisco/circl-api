import { RiskCategory } from '@prisma/client';

/**
 * Circl Guard's risk lexicon.
 *
 * The scanner is a deterministic phrase match, not a model. Three reasons:
 * it has to be auditable when someone asks why a post was escalated, it has to
 * run in-request without a network hop, and safeguarding staff have to be able to
 * add a phrase the moment they see it used — which is a database row, not a
 * deploy.
 *
 * Weights are additive and tuned so a single unambiguous phrase reaches HIGH on
 * its own, while softer phrases need to co-occur. The scanner never blocks a
 * post; it only decides where the post lands in the admin queue. False positives
 * cost a reviewer thirty seconds. False negatives cost more than that.
 */
export const riskTermSeeds: Array<[RiskCategory, string, number]> = [
  // ── Self-harm and suicidal ideation ───────────────────────────────────────
  [RiskCategory.SELF_HARM, 'kill myself', 60],
  [RiskCategory.SELF_HARM, 'end my life', 60],
  [RiskCategory.SELF_HARM, 'take my own life', 60],
  [RiskCategory.SELF_HARM, 'want to die', 55],
  [RiskCategory.SELF_HARM, 'suicidal', 55],
  [RiskCategory.SELF_HARM, 'suicide', 45],
  [RiskCategory.SELF_HARM, 'self harm', 45],
  [RiskCategory.SELF_HARM, 'hurt myself', 45],
  [RiskCategory.SELF_HARM, 'no reason to live', 50],
  [RiskCategory.SELF_HARM, "can't go on", 30],
  [RiskCategory.SELF_HARM, 'better off without me', 45],

  // ── Domestic abuse ────────────────────────────────────────────────────────
  [RiskCategory.DOMESTIC_ABUSE, 'domestic violence', 55],
  [RiskCategory.DOMESTIC_ABUSE, 'domestic abuse', 55],
  [RiskCategory.DOMESTIC_ABUSE, 'my husband hits', 60],
  [RiskCategory.DOMESTIC_ABUSE, 'my wife hits', 60],
  [RiskCategory.DOMESTIC_ABUSE, 'my partner hits', 60],
  [RiskCategory.DOMESTIC_ABUSE, 'beats me', 60],
  [RiskCategory.DOMESTIC_ABUSE, 'threatening me', 35],
  [RiskCategory.DOMESTIC_ABUSE, 'afraid to go home', 50],
  [RiskCategory.DOMESTIC_ABUSE, 'not safe at home', 50],
  [RiskCategory.DOMESTIC_ABUSE, 'refuge', 25],
  [RiskCategory.DOMESTIC_ABUSE, 'restraining order', 30],
  [RiskCategory.DOMESTIC_ABUSE, 'he locked me', 45],
  [RiskCategory.DOMESTIC_ABUSE, 'she locked me', 45],
  [RiskCategory.DOMESTIC_ABUSE, 'took my passport', 50],
  [RiskCategory.DOMESTIC_ABUSE, 'controls my money', 35],

  // ── Deportation and immigration enforcement ───────────────────────────────
  [RiskCategory.DEPORTATION_RISK, 'deported', 40],
  [RiskCategory.DEPORTATION_RISK, 'deportation', 40],
  [RiskCategory.DEPORTATION_RISK, 'removal notice', 45],
  [RiskCategory.DEPORTATION_RISK, 'detention centre', 50],
  [RiskCategory.DEPORTATION_RISK, 'immigration raid', 50],
  [RiskCategory.DEPORTATION_RISK, 'overstayed', 35],
  [RiskCategory.DEPORTATION_RISK, 'visa refused', 30],
  [RiskCategory.DEPORTATION_RISK, 'visa expired', 30],
  [RiskCategory.DEPORTATION_RISK, 'no recourse to public funds', 35],
  [RiskCategory.DEPORTATION_RISK, 'asylum refused', 40],
  [RiskCategory.DEPORTATION_RISK, 'sponsor withdrew', 40],
  [RiskCategory.DEPORTATION_RISK, 'cos revoked', 45],

  // ── Scams ─────────────────────────────────────────────────────────────────
  [RiskCategory.SCAM, 'send money first', 40],
  [RiskCategory.SCAM, 'western union', 30],
  [RiskCategory.SCAM, 'gift card', 25],
  [RiskCategory.SCAM, 'guaranteed visa', 50],
  [RiskCategory.SCAM, 'guaranteed job offer', 45],
  [RiskCategory.SCAM, 'pay a deposit today', 35],
  [RiskCategory.SCAM, 'crypto investment', 30],
  [RiskCategory.SCAM, 'double your money', 45],
  [RiskCategory.SCAM, 'no questions asked', 25],
  [RiskCategory.SCAM, 'fake documents', 55],
  [RiskCategory.SCAM, 'fake payslip', 55],
  [RiskCategory.SCAM, 'buy a cos', 55],
  [RiskCategory.SCAM, 'sell my cos', 55],

  // ── Landlord fraud and housing exploitation ───────────────────────────────
  [RiskCategory.LANDLORD_FRAUD, 'landlord took my deposit', 45],
  [RiskCategory.LANDLORD_FRAUD, 'no tenancy agreement', 35],
  [RiskCategory.LANDLORD_FRAUD, 'illegal eviction', 55],
  [RiskCategory.LANDLORD_FRAUD, 'changed the locks', 50],
  [RiskCategory.LANDLORD_FRAUD, 'threw my things out', 50],
  [RiskCategory.LANDLORD_FRAUD, 'cash only rent', 30],
  [RiskCategory.LANDLORD_FRAUD, 'no contract', 25],
  [RiskCategory.LANDLORD_FRAUD, 'overcrowded', 30],

  // ── Exploitation and modern slavery ───────────────────────────────────────
  [RiskCategory.EXPLOITATION, 'not being paid', 40],
  [RiskCategory.EXPLOITATION, 'unpaid wages', 40],
  [RiskCategory.EXPLOITATION, 'below minimum wage', 40],
  [RiskCategory.EXPLOITATION, 'working 16 hours', 35],
  [RiskCategory.EXPLOITATION, 'no days off', 30],
  [RiskCategory.EXPLOITATION, 'employer keeps my passport', 60],
  [RiskCategory.MODERN_SLAVERY, 'forced to work', 60],
  [RiskCategory.MODERN_SLAVERY, 'cannot leave the house', 55],
  [RiskCategory.MODERN_SLAVERY, 'held against my will', 65],
  [RiskCategory.MODERN_SLAVERY, 'trafficked', 65],
  [RiskCategory.MODERN_SLAVERY, 'debt bondage', 60],

  // ── Hate ──────────────────────────────────────────────────────────────────
  [RiskCategory.HATE, 'go back to your country', 45],
  [RiskCategory.HATE, 'racially abused', 40],
  [RiskCategory.HATE, 'racist attack', 50],
  [RiskCategory.HATE, 'hate crime', 50],

  // ── Compliance flagging (Guard) ───────────────────────────────────────────
  [RiskCategory.RESTRICTED_ITEM, 'prescription only', 40],
  [RiskCategory.RESTRICTED_ITEM, 'antibiotics', 40],
  [RiskCategory.RESTRICTED_ITEM, 'tramadol', 55],
  [RiskCategory.RESTRICTED_ITEM, 'codeine', 45],
  [RiskCategory.RESTRICTED_ITEM, 'skin lightening', 45],
  [RiskCategory.RESTRICTED_ITEM, 'hydroquinone', 50],
  [RiskCategory.RESTRICTED_ITEM, 'bush meat', 55],
  [RiskCategory.RESTRICTED_ITEM, 'ivory', 50],
  [RiskCategory.RESTRICTED_ITEM, 'raw milk', 30],
  [RiskCategory.RESTRICTED_ITEM, 'vape', 20],
  [RiskCategory.RESTRICTED_ITEM, 'cigarettes', 25],
  [RiskCategory.UNVERIFIED_CREDENTIAL, 'immigration advice', 35],
  [RiskCategory.UNVERIFIED_CREDENTIAL, 'i am a solicitor', 30],
  [RiskCategory.UNVERIFIED_CREDENTIAL, 'legal representation', 30],
  [RiskCategory.UNVERIFIED_CREDENTIAL, 'visa consultant', 35],
];
