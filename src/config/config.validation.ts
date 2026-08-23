import Joi from 'joi';

export const configValidationSchema = Joi.object({
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

  // ── Media storage ─────────────────────────────────────────────────────────
  // MEDIA_BUCKET is what selects the driver: set it and uploads are presigned
  // straight to S3; leave it unset and the local disk driver serves the same
  // two-step contract so composers work before a bucket exists. Local disk does
  // not survive a redeploy, so staging and production want a bucket.
  MEDIA_BUCKET: Joi.string().optional().allow(''),
  MEDIA_CDN_URL: Joi.string().uri().optional().allow(''),
  MEDIA_LOCAL_DIR: Joi.string().default('./storage/media'),
  AWS_REGION: Joi.string().default('eu-west-2'),
  AWS_ACCESS_KEY_ID: Joi.string().optional().allow(''),
  AWS_SECRET_ACCESS_KEY: Joi.string().optional().allow(''),

  // Absolute origin this API is reachable at. Used to build media URLs for the
  // local driver, so they are openable from a device rather than only from the
  // host running the server.
  PUBLIC_BASE_URL: Joi.string().uri().optional().allow(''),

  // Scheduled jobs run per process. Set this on every instance but one when
  // running more than one; every job is idempotent, so a double-run is harmless
  // rather than wrong.
  DISABLE_SCHEDULED_JOBS: Joi.string().valid('true', 'false', '').optional(),
});
