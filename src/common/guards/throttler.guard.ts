import { ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';
import { ApiErrorCode } from '../constants/api-error-code.constant';
import { ApiException } from '../exceptions/api.exception';

/**
 * Rate limiting (spec 0.14).
 *
 * Two things this fixes over the stock guard.
 *
 * The code is UPPER_SNAKE and the wait is returned. `error.code` is the only
 * thing the client branches on (0.4), and a 429 the client cannot back off from
 * correctly is a 429 it will retry into.
 *
 * Limits are per MEMBER, not per IP. The spec's table says "per user", and it
 * has to: a university hall, an office or a shared house is one IP and many
 * people, and bucketing them together locks a building out because one person
 * was busy.
 */
@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  protected async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const response = context.switchToHttp().getResponse();
    const retryAfter = Math.max(1, Math.ceil(detail?.timeToBlockExpire || 60));

    response.header?.('Retry-After', String(retryAfter));

    throw new ApiException(
      HttpStatus.TOO_MANY_REQUESTS,
      ApiErrorCode.RATE_LIMITED,
      retryAfter > 120
        ? `You have done that too many times. Try again in about ${Math.ceil(retryAfter / 60)} minutes.`
        : 'You have done that too many times. Please wait a moment and try again.',
      { data: { retryAfterSeconds: retryAfter } },
    );
  }

  /**
   * The member, falling back to the IP when there is no token.
   *
   * This guard is registered globally, so it runs BEFORE the route-level
   * JwtAuthGuard has populated `req.user` — reading that here would always be
   * undefined and quietly bucket the entire internet by IP. So the subject claim
   * is read straight off the token.
   *
   * It is deliberately not verified: this decides which counter to increment,
   * not whether the request is allowed. A forged token only ever selects its own
   * bucket, which an attacker can already do by sending no token at all, and the
   * request still has to get past real authentication a moment later.
   */
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const authenticated = req.user?.id;

    if (authenticated) return `user:${authenticated}`;

    const header = req.headers?.authorization;

    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      const subject = subjectOf(header.slice(7));

      if (subject) return `user:${subject}`;
    }

    return `ip:${req.ip}`;
  }
}

/** The `sub` claim, or null if the token is not a readable JWT. */
const subjectOf = (token: string): string | null => {
  const parts = token.split('.');

  if (parts.length !== 3) return null;

  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));

    return typeof payload === 'object' && payload !== null && typeof (payload as { sub?: unknown }).sub === 'string'
      ? (payload as { sub: string }).sub
      : null;
  } catch {
    return null;
  }
};
