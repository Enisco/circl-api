import Joi from 'joi';

/**
 * The gate this flag turns on rejects media whose `scanStatus` is not `CLEAN`, and nothing ever
 * writes `CLEAN` because no scanner exists: enabling it makes every upload permanently
 * unattachable. Refusing to boot is cheaper than a day spent wondering why nobody can send a photo.
 */
const scanFlag = Joi.boolean()
  .truthy('true')
  .falsy('false', '')
  .valid(false)
  .default(false)
  .messages({
    'any.only':
      'MEDIA_SCAN_REQUIRED cannot be enabled: no scanner exists, so nothing ever marks media ' +
      'clean and every upload would become permanently unattachable. Unset it, and remove this ' +
      'rule when a scanner is actually wired up.',
  });

export const configValidationSchema = Joi.object({
  MEDIA_SCAN_REQUIRED: scanFlag,
  APP_ENV: Joi.string().required(),
  APP_NAME: Joi.string().required(),
  APP_PORT: Joi.number().required(),
  DATABASE_URL: Joi.string().required(),
  REDIS_URL: Joi.string().required(),
  GOOGLE_CLIENT_ID: Joi.string().required(),
  GOOGLE_IOS_CLIENT_ID: Joi.string().required(),
  GOOGLE_ANDROID_CLIENT_ID: Joi.string().required(),
  APPLE_BUNDLE_ID: Joi.string().required(),
  APPLE_JWKS_URI: Joi.string().required(),
  JWT_SIGNUP_SECRET: Joi.string().required(),
  JWT_SIGNUP_EXPIRY: Joi.string().default('15m'),
  FIREBASE_PROJECT_ID: Joi.string().required(),
  FIREBASE_CLIENT_EMAIL: Joi.string().required(),
  FIREBASE_PRIVATE_KEY: Joi.string().required(),
  RESEND_API_KEY: Joi.string().required(),
  EMAIL_FROM: Joi.string().email().required(),
  EMAIL_FROM_NAME: Joi.string().required(),
  SUPPORT_EMAIL: Joi.string().email().required(),

  // ── AWS and media storage ───────────────────────────────────────────────── All four are required and the app will not start without them.
  AWS_REGION: Joi.string().required(),
  AWS_ACCESS_KEY_ID: Joi.string().required(),
  AWS_SECRET_ACCESS_KEY: Joi.string().required(),
  MEDIA_BUCKET: Joi.string().required(),
  MEDIA_UPLOAD_URL_TTL_SECONDS: Joi.number().min(60).max(3600).default(900),

  // Scheduled jobs run per process.
  DISABLE_SCHEDULED_JOBS: Joi.string().valid('true', 'false', '').optional(),

  /// Which API this process serves. Unset means both, which is the single-process deployment.
  APP_SURFACE: Joi.string().valid('all', 'member', 'admin', '').optional(),

  // ── Member auth ─────────────────────────────────────────────────────────────
  // Read on every request and never validated until now: an unset access secret makes
  // `secretOrKey` undefined, which passport accepts and then fails on in a way that looks like a
  // bad token rather than a missing configuration (B11).
  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_EXPIRY: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRY: Joi.string().default('30d'),
  CLIENT_URL: Joi.string().uri().required(),

  // ── Admin portal ────────────────────────────────────────────────────────────
  // Distinct from the member secrets on purpose, and the startup check below refuses a deployment
  // that reuses one: a single leaked secret must not mint both kinds of token.
  ADMIN_JWT_ACCESS_SECRET: Joi.string().min(48).required(),
  /// 32 bytes, base64. Encrypts TOTP secrets at rest.
  ADMIN_TOTP_ENC_KEY: Joi.string()
    .base64()
    .custom((value, helpers) =>
      Buffer.from(value, 'base64').length === 32 ? value : helpers.error('any.invalid'),
    )
    .required()
    .messages({ 'any.invalid': 'ADMIN_TOTP_ENC_KEY must decode to exactly 32 bytes.' }),
  ADMIN_TOTP_ENC_KEY_ID: Joi.string().min(1).required(),
  /// The trusted-client credential. Without it the admin API is reachable with a bearer token
  /// alone, and forwarded client IPs could not be trusted for audit or rate limiting.
  ADMIN_BFF_SECRET: Joi.string().min(32).required(),
  ADMIN_BFF_SECRET_PREVIOUS: Joi.string().min(32).allow('').optional(),
  ADMIN_CLIENT_URL: Joi.string().uri().required(),
  ADMIN_HIBP_CHECK: Joi.string().valid('true', 'false', '').optional(),

  // ── Content safety (M2) ─────────────────────────────────────────────────────
  // Declared now so the deployment kill switch exists before anything reads it.
  OPENAI_API_KEY: Joi.string().allow('').optional(),
  OPENAI_MODEL: Joi.string().allow('').optional(),
  OPENAI_MODERATION_ENABLED: Joi.string().valid('true', 'false', '').optional(),
}).custom((config, helpers) => {
  // One secret minting both member and admin tokens would make a member token forgeable into an
  // admin one by whoever held it. Refusing to boot is the only moment this can still be caught.
  if (config.ADMIN_JWT_ACCESS_SECRET === config.JWT_ACCESS_SECRET) {
    return helpers.message({
      custom: 'ADMIN_JWT_ACCESS_SECRET must differ from JWT_ACCESS_SECRET.',
    } as never);
  }

  if (config.ADMIN_BFF_SECRET === config.ADMIN_BFF_SECRET_PREVIOUS) {
    return helpers.message({
      custom:
        'ADMIN_BFF_SECRET_PREVIOUS must differ from ADMIN_BFF_SECRET (it is the rotated-out value).',
    } as never);
  }

  return config;
});
