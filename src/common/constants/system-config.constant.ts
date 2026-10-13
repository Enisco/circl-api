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

/** §5.21's grouping: which tab of the settings screen a key belongs on. */
export type ConfigGroup = 'LIMITS' | 'SAFETY' | 'SLAS' | 'OPERATIONS';

/**
 * How a value is checked before it is stored, in the smallest vocabulary that covers these keys.
 *
 * Not JSON Schema, and the reason is the error message. §5.21 says "JSON-schema validated per key",
 * and a schema validator's output — `/low: must be <= 100` against a draft pointer — is a sentence
 * for a developer, not for the person who typed 300 into a box labelled "Low". These rules carry
 * their own bounds, so a refusal can name the field, the limit and the value in words.
 *
 * `record` is the one that needed a shape of its own: `safety.classifier.weights` is "any of these
 * category names, each a number in range", which is a key set nobody should have to declare.
 */
export type ConfigRule =
  | { type: 'integer'; min: number; max: number }
  | { type: 'number'; min: number; max: number }
  | { type: 'boolean' }
  | { type: 'string'; pattern?: RegExp; maxLength?: number }
  | { type: 'enumList'; of: readonly string[]; min?: number; max?: number }
  | { type: 'object'; fields: Record<string, ConfigRule>; increasing?: string[] }
  | { type: 'record'; value: ConfigRule }
  | { type: 'stringList'; maxLength?: number; max?: number };

export interface ConfigMeta {
  label: string;
  group: ConfigGroup;
  description: string;
  rule: ConfigRule;
}

const count = (min: number, max: number): ConfigRule => ({ type: 'integer', min, max });
const minutes = (max = 10_080): ConfigRule => ({ type: 'integer', min: 1, max });

/**
 * Every key the settings screen shows, with the words staff read beside it.
 *
 * Held here rather than in the database because a description is documentation, and documentation
 * that lives in a row is documentation nobody reviews. The **value** is in the database; what the
 * value means is in the repository.
 *
 * `appVersions` is deliberately absent: it has its own endpoint, its own shape and its own
 * validation (semver, ordered, a store host per platform), and offering it in a generic "edit this
 * JSON" box is how somebody ships a force-update with a typo in it.
 */
export const SYSTEM_CONFIG_META: Record<string, ConfigMeta> = {
  'limits.maxInterests': {
    label: 'Interests a member may pick',
    group: 'LIMITS',
    description:
      'The ceiling on a profile’s interests. The app’s picker reads it from the catalogue.',
    rule: count(1, 30),
  },
  'limits.maxLanguages': {
    label: 'Languages a member may list',
    group: 'LIMITS',
    description: 'Spoken languages on a profile.',
    rule: count(1, 20),
  },
  'limits.connectMinimumAge': {
    label: 'Minimum age for Connect',
    group: 'LIMITS',
    description:
      'Nobody below this age reaches Connect at all. Raising it does not remove existing profiles; it stops new ones.',
    rule: count(16, 25),
  },
  'limits.nearMeRadiusKm': {
    label: '“Near me” radius (km)',
    group: 'LIMITS',
    description: 'How far “near me” reaches on the member’s own map.',
    rule: count(1, 200),
  },
  'limits.maxHobbies': {
    label: 'Hobbies a member may pick',
    group: 'LIMITS',
    description: 'The ceiling on a Connect profile’s hobbies.',
    rule: count(1, 30),
  },
  'limits.minHobbies': {
    label: 'Hobbies a Connect profile needs',
    group: 'LIMITS',
    description:
      'Checked when a profile is created, never when one is edited: a member who joined before the rule keeps their place.',
    rule: count(0, 10),
  },
  'limits.minConnectPhotos': {
    label: 'Photos a Connect profile needs',
    group: 'LIMITS',
    description: 'Checked on create only, for the same reason as the hobby floor.',
    rule: count(0, 10),
  },
  'limits.maxCardPhotos': {
    label: 'Photos on a Connect card',
    group: 'LIMITS',
    description: 'How many of their gallery a member may pin to the card other people swipe.',
    rule: count(1, 10),
  },
  'limits.minPromptAnswer': {
    label: 'Shortest prompt answer',
    group: 'LIMITS',
    description:
      'Characters. Low on purpose: “Nigerian jollof” is a complete answer to “Ask me about”.',
    rule: count(1, 200),
  },
  'limits.maxPromptAnswer': {
    label: 'Longest prompt answer',
    group: 'LIMITS',
    description: 'Characters.',
    rule: count(20, 1000),
  },

  'safety.tierThresholds': {
    label: 'Risk tier thresholds',
    group: 'SAFETY',
    description:
      'The score at which content becomes LOW, MEDIUM, HIGH and CRITICAL. Must increase: a MEDIUM floor above the HIGH floor is a band nothing can ever land in.',
    rule: {
      type: 'object',
      fields: {
        low: count(0, 1000),
        medium: count(0, 1000),
        high: count(0, 1000),
        critical: count(0, 1000),
      },
      increasing: ['low', 'medium', 'high', 'critical'],
    },
  },
  'safety.classifier': {
    label: 'Classifier',
    group: 'SAFETY',
    description:
      'Whether the model runs, how long it is given, how much of the blended score it contributes, and the per-category multipliers. Switching it off leaves the lexicon, which is the half staff maintain.',
    rule: {
      type: 'object',
      fields: {
        enabled: { type: 'boolean' },
        model: { type: 'string', maxLength: 64 },
        timeoutMs: count(100, 30_000),
        /** How much of the blended score the classifier contributes beside the lexicon (§6.3). */
        weight: { type: 'number', min: 0, max: 1 },
        /** Per-category multipliers. Any category not listed multiplies by 1. */
        multipliers: { type: 'record', value: { type: 'number', min: 0, max: 5 } },
      },
    },
  },
  'safety.criticalCategories': {
    label: 'Categories that escalate on their own',
    group: 'SAFETY',
    description:
      'A single phrase in one of these, weighing as much as the HIGH threshold, opens a Guard case rather than adding to a score.',
    rule: { type: 'stringList', maxLength: 40, max: 20 },
  },
  'safety.strikeExpiryDays': {
    label: 'Strike expiry (days)',
    group: 'SAFETY',
    description: 'How long a strike counts against a member.',
    rule: count(1, 3650),
  },
  'safety.suggestSuspensionAtStrikes': {
    label: 'Suggest suspension at',
    group: 'SAFETY',
    description:
      'Active strikes at which the portal suggests a suspension. A suggestion, never an automatic one.',
    rule: count(1, 20),
  },

  'reports.slaMinutes': {
    label: 'Report deadlines (minutes)',
    group: 'SLAS',
    description: 'Per priority. Wall clock, not working hours.',
    rule: {
      type: 'object',
      fields: { URGENT: minutes(), HIGH: minutes(), NORMAL: minutes() },
    },
  },
  'moderation.anonymousSlaWorkingMinutes': {
    label: 'Anonymous post deadline (working minutes)',
    group: 'SLAS',
    description: 'Counted against the working hours below, because nobody is on at 3am.',
    rule: minutes(),
  },
  'moderation.workingHours': {
    label: 'Working hours',
    group: 'OPERATIONS',
    description: 'The window the working-hours deadlines are counted in.',
    rule: {
      type: 'object',
      fields: {
        tz: { type: 'string', maxLength: 64 },
        days: { type: 'enumList', of: ['1', '2', '3', '4', '5', '6', '7'], min: 1, max: 7 },
        start: { type: 'string', pattern: /^([01]\d|2[0-3]):[0-5]\d$/ },
        end: { type: 'string', pattern: /^([01]\d|2[0-3]):[0-5]\d$/ },
      },
    },
  },
  'appeals.slaHours': {
    label: 'Appeal deadline (hours)',
    group: 'SLAS',
    description: 'How long an appeal has before it reads as overdue.',
    rule: count(1, 720),
  },
  'support.firstResponseSlaMinutes': {
    label: 'Support first response (minutes)',
    group: 'SLAS',
    description: 'A support thread with no staff reply inside this is overdue.',
    rule: minutes(),
  },

  'exports.maxRows': {
    label: 'Export row ceiling',
    group: 'OPERATIONS',
    description:
      'An export above this is refused rather than built, with a message telling the asker to narrow the filters.',
    rule: count(100, 1_000_000),
  },
  'analytics.cacheTtlSeconds': {
    label: 'Analytics cache (seconds)',
    group: 'OPERATIONS',
    description:
      'Today’s numbers are cached briefly and historical ones for longer, because yesterday does not change.',
    rule: {
      type: 'object',
      fields: { today: count(0, 86_400), historical: count(0, 604_800) },
    },
  },
};
