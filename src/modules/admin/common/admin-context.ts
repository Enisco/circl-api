import { Injectable, NestMiddleware } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
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
 * Establishes the context for one admin request: who, from where, under which request id.
 *
 * **The address is `req.ip` and nothing else.** This used to parse `X-Forwarded-For` itself and
 * pick the entry one hop from the right, on the assumption that the chain reads
 * `<browser>, <portal>` — the portal rewriting the header and the platform edge appending one hop.
 * That assumption is a property of somebody else's infrastructure, and it broke as soon as the API
 * was deployed behind an edge that appends a different number of hops: the address came out
 * different on two requests seconds apart, which locked staff out of sign-in, because the MFA
 * ticket was bound to it.
 *
 * `req.ip` is Express's own answer, under the `trust proxy` setting configured in `main.ts`, and
 * it is the one that stays correct when the hosting changes. Where that resolves to a proxy rather
 * than a person, an audit entry naming the proxy is honest about what the API was told; a
 * hand-picked entry from a header anybody can set was not.
 */
@Injectable()
export class AdminClientContextMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    // The logger generates one per request when the caller sends no `x-correlation-id`, and puts
    // it on `req.id`. Reading only the header left every audit entry without a request id, which
    // is the field that ties an entry to the log lines around it.
    const header = request.headers['x-correlation-id'];
    const generated = (request as Request & { id?: string | number }).id;
    const requestId =
      (Array.isArray(header) ? header[0] : header) ??
      (generated !== undefined ? String(generated) : undefined);
    const agent = request.headers['user-agent'];

    const clientIp = request.ip ?? null;

    // Published on the request as well as in the context, for `CustomThrottlerGuard` — which is in
    // `src/common` and must not import anything from the admin module. It reads this field when it
    // is set. It is now the same value the throttler would have read for itself; the field stays
    // so that the throttler has one source for the address and keeps working if this changes.
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
}
