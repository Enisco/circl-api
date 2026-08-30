import { applyDecorators } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

/** The limits from spec 0.14, plus messaging's own pair from 5.7. */
export const RATE_LIMITS = {
  /** Content creation: post, reply, response, guide, group. 20 per hour. */
  CREATE: { limit: 20, ttl: 3_600_000 },
  /** Reactions and joins. 120 per hour. */
  REACT: { limit: 120, ttl: 3_600_000 },
  /** Reads. 600 per minute. Also the default for anything unclassified. */
  READ: { limit: 600, ttl: 60_000 },
  /** Reports. 10 per hour. */
  REPORT: { limit: 10, ttl: 3_600_000 },
  /** Messaging (5.7): 60 a minute AND 300 an hour. */
  MESSAGE_MINUTE: { limit: 60, ttl: 60_000 },
  MESSAGE_HOUR: { limit: 300, ttl: 3_600_000 },
  /** Anything that sends a six-digit code to an inbox. 5 an hour. */
  OTP: { limit: 5, ttl: 3_600_000 },
} as const;

type LimitName = keyof typeof RATE_LIMITS;

/** Applies a limit to one route. */
export const RateLimit = (primary: LimitName, secondary?: LimitName) =>
  applyDecorators(
    Throttle({
      default: RATE_LIMITS[primary],
      ...(secondary ? { secondary: RATE_LIMITS[secondary] } : {}),
    }),
  );
