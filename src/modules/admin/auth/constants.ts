export const AUTH_CONSTANTS = {
  MAX_LOGIN_ATTEMPTS: 5,
  MAX_LOCK_TIME: 15,
  TOKEN_TYPES: {
    ACCESS: 'access',
    REFRESH: 'refresh',
  },
  SESSION: {
    REFRESH_TOKEN_TTL_DAYS: 7,
  },
  COOKIE: {
    OPTIONS: {
      httpOnly: true,
      path: '/api/v1/admin/auth/refresh',
      priority: 'high',
    },
  },
} as const;

export const SESSION_CONSTANTS = {
  MAX_ACTIVE_SESSIONS: 3,
} as const;

export const COOKIE_NAMESPACE_MAP = {
  local: 'local',
  development: 'q8m4z2',
  staging: 'p3hni9',
  production: 'v6k1t5',
} as const;

export const JWT_BLACKLIST_PREFIX = 'admin_jwt_blacklist_';
