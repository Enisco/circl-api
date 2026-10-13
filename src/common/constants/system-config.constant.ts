/**
 * The settings staff can change without a release (§4.12).
 *
 * Every one of these was a constant in the source, which meant that raising the strike expiry or
 * widening the interest limit was a deploy — and that the number the portal showed and the number
 * the API enforced were two separate edits. The defaults below are those constants, moved: nothing
 * has to be seeded for the platform to behave exactly as it did, and a row in `system_config` is
 * an override rather than a requirement.
 *
 * Keys are dotted and grouped by what they govern, because the permission that edits them is
 * granted by group and the audit entry is read by somebody looking for "who changed safety".
 */
export const SYSTEM_CONFIG_KEYS = {
  MAX_INTERESTS: 'limits.maxInterests',
  MAX_LANGUAGES: 'limits.maxLanguages',
  CONNECT_MINIMUM_AGE: 'limits.connectMinimumAge',
  NEAR_ME_RADIUS_KM: 'limits.nearMeRadiusKm',
  MAX_HOBBIES: 'limits.maxHobbies',
  MIN_HOBBIES: 'limits.minHobbies',
  MIN_CONNECT_PHOTOS: 'limits.minConnectPhotos',
  MAX_CARD_PHOTOS: 'limits.maxCardPhotos',
  MIN_PROMPT_ANSWER: 'limits.minPromptAnswer',
  MAX_PROMPT_ANSWER: 'limits.maxPromptAnswer',

  TIER_THRESHOLDS: 'safety.tierThresholds',
  CLASSIFIER: 'safety.classifier',
  CRITICAL_CATEGORIES: 'safety.criticalCategories',
  STRIKE_EXPIRY_DAYS: 'safety.strikeExpiryDays',
  SUGGEST_SUSPENSION_AT_STRIKES: 'safety.suggestSuspensionAtStrikes',

  REPORT_SLA_MINUTES: 'reports.slaMinutes',
  ANONYMOUS_SLA_WORKING_MINUTES: 'moderation.anonymousSlaWorkingMinutes',
  WORKING_HOURS: 'moderation.workingHours',
  APPEALS_SLA_HOURS: 'appeals.slaHours',
  SUPPORT_FIRST_RESPONSE_SLA_MINUTES: 'support.firstResponseSlaMinutes',

  APP_VERSIONS: 'appVersions',
  EXPORT_MAX_ROWS: 'exports.maxRows',
  ANALYTICS_CACHE_TTL_SECONDS: 'analytics.cacheTtlSeconds',
} as const;

export type SystemConfigKey = (typeof SYSTEM_CONFIG_KEYS)[keyof typeof SYSTEM_CONFIG_KEYS];

export interface WorkingHours {
  tz: string;
  /** ISO weekdays, Monday = 1. */
  days: number[];
  start: string;
  end: string;
}

/**
 * The shape and the default of every key, together.
 *
 * One table, so `SystemConfigService.get` is typed by key and a `PATCH` has something to validate
 * against. A default that lived apart from its type is how a stored override of the wrong shape
 * gets read back as a number and divides by a string.
 */
export const SYSTEM_CONFIG_DEFAULTS = {
  'limits.maxInterests': 8,
  'limits.maxLanguages': 6,
  'limits.connectMinimumAge': 18,
  'limits.nearMeRadiusKm': 25,
  /**
   * The four Connect limits the client reads from `taxonomy.limits` and the API enforces.
   *
   * `minConnectPhotos` gates **creating** a Connect profile, never editing one: a member who
   * joined before the rule keeps their place, and an edit that demanded two more pictures first
   * would lock them out of their own profile.
   *
   * `minPromptAnswer` is 20 rather than the 50 first proposed, because the questions served
   * include "Ask me about", where "Nigerian jollof" is a complete and good answer at fifteen
   * characters. A fifty-character floor would reject it.
   */
  'limits.maxHobbies': 8,
  // Three, and the card is the reason: hobbies are what a stranger taps to start a conversation,
  // so a profile with one offers one way in. Enforced on create only, like the photo floor.
  'limits.minHobbies': 3,
  'limits.minConnectPhotos': 3,
  // The photographs a member picks as their card. Three is what the deck's swipe was designed
  // around; more is a gallery, which the profile already has.
  'limits.maxCardPhotos': 3,
  'limits.minPromptAnswer': 20,
  'limits.maxPromptAnswer': 100,

  'safety.tierThresholds': { low: 1, medium: 30, high: 55, critical: 90 },
  /**
   * `enabled` is **false until the classifier ships** (M2 stage 17), where the spec's default is
   * true.
   *
   * It is not a preference, it is a statement about what exists: with it on, §6.5 holds every
   * lexicon-clean post as `LIMITED` for the second or two until the classifier answers, so that
   * nothing the classifier would hold reaches a feed first. Switched on before anything answers,
   * that second becomes for ever and the platform disappears from its own feeds. Off, the lexicon
   * verdict is final and recorded `DEGRADED`, which is exactly what §6.7 prescribes for a
   * classifier that is not available.
   *
   * A stored override flips it without a deploy, which is how it will be turned on.
   */
  'safety.classifier': {
    enabled: false,
    model: 'omni-moderation-latest',
    timeoutMs: 4000,
    weight: 0.6,
    /**
     * §6.3's per-category multipliers, which are what turn a raw moderation score into a Circl
     * one. They are here rather than in code because they are the judgement in the whole
     * arrangement: `sexual/minors` at 1.5 says a model that is half sure about a child is already
     * past our threshold, and that is a decision for the people who answer the queue.
     *
     * Any category not listed multiplies by 1.
     */
    multipliers: {
      'self-harm/intent': 1.2,
      'self-harm/instructions': 1.2,
      'sexual/minors': 1.5,
      'hate/threatening': 1.1,
      'harassment/threatening': 1.1,
      'violence/graphic': 1.0,
      'illicit/violent': 1.1,
    } as Record<string, number>,
  },
  'safety.criticalCategories': [
    'SELF_HARM',
    'DOMESTIC_ABUSE',
    'EXPLOITATION',
    'MODERN_SLAVERY',
    'DEPORTATION_RISK',
  ] as string[],
  'safety.strikeExpiryDays': 90,
  'safety.suggestSuspensionAtStrikes': 3,

  'reports.slaMinutes': { URGENT: 60, HIGH: 240, NORMAL: 1440 },
  'moderation.anonymousSlaWorkingMinutes': 240,
  'moderation.workingHours': {
    tz: 'Europe/London',
    days: [1, 2, 3, 4, 5],
    start: '09:00',
    end: '18:00',
  } as WorkingHours,
  'appeals.slaHours': 72,
  'support.firstResponseSlaMinutes': 480,

  appVersions: {
    IOS: {
      minimum: '1.0.0',
      latest: '1.0.0',
      forceBelow: '1.0.0',
      storeUrl: null as string | null,
    },
    ANDROID: {
      minimum: '1.0.0',
      latest: '1.0.0',
      forceBelow: '1.0.0',
      storeUrl: null as string | null,
    },
  },
  'exports.maxRows': 100_000,
  'analytics.cacheTtlSeconds': { today: 300, historical: 3600 },
} as const;

export type SystemConfigValues = {
  [K in SystemConfigKey]: (typeof SYSTEM_CONFIG_DEFAULTS)[K];
};
