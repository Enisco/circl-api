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

  'safety.tierThresholds': { low: 1, medium: 30, high: 55, critical: 90 },
  'safety.classifier': {
    enabled: true,
    model: 'omni-moderation-latest',
    timeoutMs: 4000,
    weight: 0.6,
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
