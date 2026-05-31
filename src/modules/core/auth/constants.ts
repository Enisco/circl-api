export const AUTH_CONSTANTS = {
  MAX_LOGIN_ATTEMPTS: 5,
  MAX_LOCK_TIME: 15,
  TOKEN_TYPES: {
    ACCESS: 'access',
    REFRESH: 'refresh',
  },
  SESSION: {
    REFRESH_TOKEN_TTL_DAYS: 30,
    ACCESS_TOKEN_TTL_MINUTES: 30,
  },
  COOKIE: {
    REFRESH_TOKEN_KEY: 'refreshToken',
    ACCESS_TOKEN_KEY: 'accessToken',
    OPTIONS: {
      httpOnly: true,
      path: '/',
      priority: 'high',
    },
  },
} as const;

export const SESSION_CONSTANTS = {
  MAX_ACTIVE_SESSIONS: 5,
} as const;

export const JWT_BLACKLIST_PREFIX = 'jwt_blacklist_';
