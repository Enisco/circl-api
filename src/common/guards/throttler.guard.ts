import { ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';
import { ApiErrorCode } from '../constants/api-error-code.constant';
import { ApiException } from '../exceptions/api.exception';

/** Rate limiting (spec 0.14). */
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
   * The token is read unverified because this only picks a bucket. The guard runs
   * before JwtAuthGuard, so `req.user` is not set yet and everyone behind one IP
   * would otherwise share a limit.
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
