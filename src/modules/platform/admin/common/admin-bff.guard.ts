import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';
import { ApiErrorCode, ApiException } from '@/common';

const HEADER = 'x-circl-admin-client';

/**
 * The trusted-client credential: proof that a request came through the admin portal's own server
 * and not from the open internet.
 *
 * This is what keeps a stolen bearer token from being enough on its own, and it is also what makes
 * the forwarded client IP worth recording — without it, anybody could choose which address an
 * audit entry blames.
 *
 * A missing or wrong credential is answered **404**, not 403: a 403 confirms the route exists, and
 * the admin surface is not something to confirm to an unauthenticated caller.
 */
@Injectable()
export class AdminBffGuard implements CanActivate {
  private readonly secrets: string[];
  private readonly enforced: boolean;

  constructor(config: ConfigService) {
    this.secrets = [
      config.get<string>('ADMIN_BFF_SECRET'),
      // Two values accepted during a rotation, so the secret can be changed without a window in
      // which the portal cannot reach the API.
      config.get<string>('ADMIN_BFF_SECRET_PREVIOUS'),
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);

    // Enforced where the API is reachable from outside. Locally it would mean every curl and every
    // end-to-end run carried a header that proves nothing on a loopback interface.
    this.enforced = ['staging', 'production'].includes(config.get<string>('APP_ENV') ?? 'local');
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & { adminBffTrusted?: boolean }>();
    const presented = request.headers[HEADER];
    const value = Array.isArray(presented) ? presented[0] : presented;
    const trusted = typeof value === 'string' && this.matches(value);

    // Recorded either way: the context middleware trusts the forwarded IP chain only when this is
    // true, so "we could not verify the caller" has to be distinguishable from "we did".
    request.adminBffTrusted = trusted;

    if (!this.enforced || trusted) return true;

    throw ApiException.notFound('Not found.', ApiErrorCode.BFF_REQUIRED);
  }

  private matches(presented: string): boolean {
    const candidate = Buffer.from(presented, 'utf8');

    // Length first: timingSafeEqual throws on a mismatch, and comparing lengths separately is not
    // a leak worth worrying about — the length of a 32-byte secret is not the secret.
    return this.secrets.some(secret => {
      const expected = Buffer.from(secret, 'utf8');

      return expected.length === candidate.length && timingSafeEqual(expected, candidate);
    });
  }
}
