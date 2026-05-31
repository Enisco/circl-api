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
  ADMIN_JWT_ACCESS_SECRET: Joi.string().required(),
  ADMIN_JWT_ACCESS_EXPIRY: Joi.string().default('15m'),
  ADMIN_JWT_REFRESH_SECRET: Joi.string().required(),
  ADMIN_JWT_REFRESH_EXPIRY: Joi.string().default('14d'),
  FIREBASE_PROJECT_ID: Joi.string().required(),
  FIREBASE_CLIENT_EMAIL: Joi.string().required(),
  FIREBASE_PRIVATE_KEY: Joi.string().required(),
});
