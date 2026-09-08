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
});
