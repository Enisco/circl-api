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
   * The member, falling back to the IP when there is no token. Read unverified because this only
   * picks a bucket: the guard runs before JwtAuthGuard, so `req.user` is not set yet.
   *
   * **`req.adminClientIp` before `req.ip`.** Admin requests arrive through the portal's own
   * server, so `req.ip` is the portal for every member of staff — one bucket for the whole team,
   * which meant the sixth sign-in attempt in fifteen minutes *by anybody* was refused, and on a
   * loopback (`::1`) the fifth local login did it too. The admin context middleware resolves the
   * real client address from the forwarded chain, having verified the portal's credential, and
   * leaves it on the request; this reads it where it is there. Set by the admin middleware and
   * nothing else, so a member request cannot choose its own bucket by sending a header.
   */
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const authenticated = req.user?.id;

    if (authenticated) return `user:${authenticated}`;

    const header = req.headers?.authorization;

    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      const subject = subjectOf(header.slice(7));

      if (subject) return `user:${subject}`;
    }

    const ip = typeof req.adminClientIp === 'string' ? req.adminClientIp : req.ip;

    // A refresh carries its token in the body: keyed on the account it belongs to, so one
    // session's retry storm cannot lock out the rest of the team.
    const refreshSubject =
      typeof req.body?.refreshToken === 'string' ? subjectOf(req.body.refreshToken) : null;

    if (refreshSubject) return `user:${refreshSubject}`;

    // Sign-in is keyed on the address **and** the account. The limit exists to slow down guessing
    // at one account's password, and the lock behind it is per account — so a bucket shared by
    // everybody signing in from one office is the wrong shape in both directions: it refuses
    // colleagues and it lets an attacker spend somebody else's allowance.
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : null;

    if (email) return `ip:${ip}|email:${email}`;

    return `ip:${ip}`;
  }
}

/** The `sub` claim, or null if the token is not a readable JWT. */
const subjectOf = (token: string): string | null => {
  const parts = token.split('.');

  if (parts.length !== 3) return null;

  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));

    return typeof payload === 'object' &&
      payload !== null &&
      typeof (payload as { sub?: unknown }).sub === 'string'
      ? (payload as { sub: string }).sub
      : null;
  } catch {
    return null;
  }
};
