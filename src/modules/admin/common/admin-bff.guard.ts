import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';
import { ApiErrorCode, ApiException } from '@/common';

export const ADMIN_BFF_HEADER = 'x-circl-admin-client';

/**
 * Whether a request carries the portal's own credential, and whether that is enforced here.
 *
 * Extracted from the guard because the **middleware needs the same answer and runs first.**
 * `AdminClientContextMiddleware` decides whether to trust `X-Forwarded-For`, and it used to read a
 * flag the guard sets — but middleware runs before guards in Nest, so the flag was always
 * undefined and the forwarded address was never trusted. Two consequences, both live in
 * production:
 *
 *  - **Every audit entry recorded the portal's outbound IP** rather than the staff member's. An
 *    audit trail that cannot say where an action came from is missing the field it exists for.
 *  - **Staff sign-in failed intermittently.** The MFA ticket is bound to the client IP, and on a
 *    serverless portal the outbound address can differ between `login` and `mfa/verify` — so the
 *    second request arrived from a different address and the ticket was refused as
 *    `MFA_TOKEN_INVALID`, with nothing to retry that would help.
 *
 * So trust is established in the middleware, where it is needed, and the guard enforces it.
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
 * This is what keeps a stolen bearer token from being enough on its own, and it is also what makes
 * the forwarded client IP worth recording — without it, anybody could choose which address an
 * audit entry blames.
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

    // Set by `AdminClientContextMiddleware`, which runs first and needs the same answer to decide
    // whether the forwarded client IP can be believed. Recomputed only where the middleware did
    // not run — a route outside `api/v1/admin` that still carries this guard — so there is one
    // comparison per request and one definition of trust.
    const trusted = request.adminBffTrusted ?? this.bff.matches(request.headers[ADMIN_BFF_HEADER]);

    request.adminBffTrusted = trusted;

    if (!this.bff.enforced || trusted) return true;

    throw ApiException.notFound('Not found.', ApiErrorCode.BFF_REQUIRED);
  }
}
