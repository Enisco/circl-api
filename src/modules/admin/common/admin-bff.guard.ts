import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';
import { ApiErrorCode, ApiException } from '@/common';

export const ADMIN_BFF_HEADER = 'x-circl-admin-client';

/**
 * Whether a request carries the portal's own credential, and whether that is enforced here.
 *
 * A separate value rather than a method on the guard because the answer is a property of the
 * configuration, not of one request, and because it was once needed in two places at once.
 *
 * It no longer decides which IP to believe. `AdminClientContextMiddleware` used to read
 * `X-Forwarded-For` when this credential matched, and picking an entry out of that chain meant
 * guessing how many hops the hosting appends — which came out differently on two requests seconds
 * apart and locked staff out of sign-in, because the MFA ticket was bound to the address. The
 * middleware now takes `req.ip` and nothing else; this credential is only what it says it is,
 * which is proof the call came through the portal's own server.
 */
export interface AdminBffCheck {
  /** Timing-safe (S14.4), and false when no secret is configured. */
  matches(presented: unknown): boolean;
  /** Only where the API is reachable from outside: locally a header proves nothing on loopback. */
  enforced: boolean;
}

export const adminBffCheck = (config: ConfigService): AdminBffCheck => {
  const secrets = [
    config.get<string>('ADMIN_BFF_SECRET'),
    // Two values accepted during a rotation, so the secret can be changed without a window in
    // which the portal cannot reach the API.
    config.get<string>('ADMIN_BFF_SECRET_PREVIOUS'),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  return {
    enforced: ['staging', 'production'].includes(config.get<string>('APP_ENV') ?? 'local'),
    matches: (presented: unknown): boolean => {
      const value = Array.isArray(presented) ? presented[0] : presented;

      if (typeof value !== 'string' || !value.length) return false;

      const candidate = Buffer.from(value, 'utf8');

      return secrets.some(secret => {
        const expected = Buffer.from(secret, 'utf8');

        // Length first, because `timingSafeEqual` throws on a mismatch — and the length of a
        // secret is not the secret.
        return expected.length === candidate.length && timingSafeEqual(expected, candidate);
      });
    },
  };
};

/**
 * The trusted-client credential: proof that a request came through the admin portal's own server
 * and not from the open internet.
 *
 * This is what keeps a stolen bearer token from being enough on its own.
 *
 * A missing or wrong credential is answered **404**, not 403: a 403 confirms the route exists, and
 * the admin surface is not something to confirm to an unauthenticated caller.
 */
@Injectable()
export class AdminBffGuard implements CanActivate {
  private readonly bff: AdminBffCheck;

  constructor(config: ConfigService) {
    this.bff = adminBffCheck(config);
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & { adminBffTrusted?: boolean }>();

    // Computed here, once, and published on the request. Nothing upstream needs the answer any
    // more — the middleware stopped using it when the client IP stopped coming from a header — but
    // the flag stays because more than one guard can run on the same request.
    const trusted = request.adminBffTrusted ?? this.bff.matches(request.headers[ADMIN_BFF_HEADER]);

    request.adminBffTrusted = trusted;

    if (!this.bff.enforced || trusted) return true;

    throw ApiException.notFound('Not found.', ApiErrorCode.BFF_REQUIRED);
  }
}
