import { applyDecorators } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

/**
 * The limits from spec 0.14, plus messaging's own pair from 5.7.
 *
 * Named rather than repeated as numbers, so the table in the spec and the
 * decorators on the controllers can be read against each other.
 */
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
} as const;

type LimitName = keyof typeof RATE_LIMITS;

/**
 * Applies a limit to one route.
 *
 * Every throttler registered in ThrottlerModule applies to EVERY route — there
 * is no such thing as an inactive named bucket. So there are exactly two
 * registered, and this overrides them per route rather than adding more:
 *
 *   `default`   — the read limit, which is what unclassified traffic should get
 *   `secondary` — effectively unlimited unless a route asks for a second window
 *
 * Registering a third named bucket at, say, 20 an hour would silently cap every
 * read in the product at 20 an hour, because that bucket would apply to reads
 * too. That is exactly the bug this shape prevents.
 */
export const RateLimit = (primary: LimitName, secondary?: LimitName) =>
  applyDecorators(
    Throttle({
      default: RATE_LIMITS[primary],
      ...(secondary ? { secondary: RATE_LIMITS[secondary] } : {}),
    }),
  );
