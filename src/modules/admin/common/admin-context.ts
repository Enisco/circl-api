import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ADMIN_BFF_HEADER, AdminBffCheck, adminBffCheck } from './admin-bff.guard';
import { AsyncLocalStorage } from 'async_hooks';
import { isIP } from 'net';
import { NextFunction, Request, Response } from 'express';

/** Who did it, from where, under which request. Attached to every audit entry. */
export interface AdminContext {
  clientIp: string | null;
  userAgent: string | null;
  requestId: string | null;
  idempotencyKey: string | null;
  /** Filled by the JWT strategy once the staff member is known. */
  actorId?: string;
  actorRole?: string;
  actorSessionId?: string;
}

const storage = new AsyncLocalStorage<AdminContext>();

/**
 * The context of the request being handled, for code too deep to be handed it.
 *
 * Audit entries must carry the actor, their IP and the request id, and a signature that asks each
 * caller for them is a signature each caller can get wrong — the one that forgets writes an entry
 * that looks complete and names nobody. Reading them from here instead means there is nothing to
 * pass and nothing to omit.
 */
export const adminContext = {
  run: <T>(context: AdminContext, work: () => T): T => storage.run(context, work),
  current: (): AdminContext | undefined => storage.getStore(),
  /** Records the staff member once authentication has identified them. */
  identify: (actor: { id: string; roleCode: string; sessionId: string }): void => {
    const context = storage.getStore();

    if (!context) return;

    context.actorId = actor.id;
    context.actorRole = actor.roleCode;
    context.actorSessionId = actor.sessionId;
  },
};

const MAX_USER_AGENT = 512;

/**
 * Establishes the context for one admin request, and works out which IP to believe.
 *
 * The browser talks to the portal's own server, which talks to this API, so `req.ip` is the
 * portal — the same value for every member of staff. The portal therefore replaces
 * `X-Forwarded-For` with the browser's address and nothing else, and the platform edge appends its
 * own hop, leaving `<client>, <bff>`.
 *
 * That chain is only worth reading **because** the trusted-client credential passed: without it,
 * anybody could set the header and choose which IP an audit entry blames. So the forwarded value
 * is used when the BFF guard has vouched for the request, and `req.ip` when it has not — and an
 * entry that names the portal is at least honest about what it knows.
 */
@Injectable()
export class AdminClientContextMiddleware implements NestMiddleware {
  private readonly bff: AdminBffCheck;

  constructor(config: ConfigService) {
    this.bff = adminBffCheck(config);
  }

  use(request: Request, response: Response, next: NextFunction): void {
    // **Established here, not read from the guard.** Middleware runs before guards, so the flag
    // `AdminBffGuard` sets does not exist yet at this point — reading it meant the forwarded
    // client IP was never trusted, so every audit entry recorded the portal's own address and the
    // IP-bound MFA ticket broke whenever the portal's outbound address changed between two
    // requests. The guard still enforces the credential; this decides whether to believe the
    // chain, which is a question only this middleware asks.
    (request as Request & { adminBffTrusted?: boolean }).adminBffTrusted = this.bff.matches(
      request.headers[ADMIN_BFF_HEADER],
    );

    // The logger generates one per request when the caller sends no `x-correlation-id`, and puts
    // it on `req.id`. Reading only the header left every audit entry without a request id, which
    // is the field that ties an entry to the log lines around it.
    const header = request.headers['x-correlation-id'];
    const generated = (request as Request & { id?: string | number }).id;
    const requestId =
      (Array.isArray(header) ? header[0] : header) ??
      (generated !== undefined ? String(generated) : undefined);
    const agent = request.headers['user-agent'];

    const clientIp = this.clientIp(request);

    // Published on the request as well as in the context, for `CustomThrottlerGuard` — which is in
    // `src/common` and must not import anything from the admin module. The throttler keyed
    // unauthenticated routes on `req.ip`, which for every member of staff is the portal's own
    // outbound address: one bucket for the whole team, so the sixth sign-in attempt in fifteen
    // minutes **by anybody** was refused. It reads this field when it is set.
    (request as Request & { adminClientIp?: string | null }).adminClientIp = clientIp;

    const context: AdminContext = {
      clientIp,
      userAgent: typeof agent === 'string' ? agent.slice(0, MAX_USER_AGENT) : null,
      requestId: requestId ?? null,
      idempotencyKey:
        typeof request.headers['idempotency-key'] === 'string'
          ? request.headers['idempotency-key']
          : null,
    };

    // Nothing from an admin response may be cached anywhere: these payloads are somebody's
    // personal data and a shared cache is a second place it lives (S14.2).
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    response.setHeader('Referrer-Policy', 'no-referrer');

    adminContext.run(context, () => next());
  }

  private clientIp(request: Request): string | null {
    const trusted = (request as Request & { adminBffTrusted?: boolean }).adminBffTrusted === true;

    if (trusted) {
      const forwarded = request.headers['x-forwarded-for'];
      const chain = (Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? ''))
        .split(',')
        .map(part => part.trim())
        .filter(Boolean);

      // The entry immediately left of the hop the edge appended.
      const candidate = chain.length >= 2 ? chain[chain.length - 2] : chain[0];

      if (candidate && isIP(candidate)) return candidate;
    }

    return request.ip ?? null;
  }
}
