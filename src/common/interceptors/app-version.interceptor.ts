import {
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { Request } from 'express';
import { AppPolicyService } from '@/modules/platform/app';
import { ApiErrorCode } from '../constants';
import { ApiException } from '../exceptions';

/**
 * Paths that answer whatever build is asking (§5.21).
 *
 * Each one is here because a forced update is a dead end without it:
 *
 *  - **`/app/version-policy`** is the explanation of the gate. Gating it leaves an app told to
 *    update with no way to find out where to.
 *  - **`/auth/*`** because the update screen may need a session to be refreshed, and because an
 *    app that cannot even reach the sign-in screen cannot show the member anything at all.
 *  - **`/guard/resources`** because those are the crisis lines. Somebody in trouble on an old
 *    build still reaches a phone number, and no product decision outranks that.
 *  - **`/health`** so an orchestrator's probe is never answered with a product policy.
 */
const ALWAYS_ALLOWED = [
  '/app/version-policy',
  '/auth/',
  '/guard/resources',
  '/health',
  '/taxonomy',
  /**
   * The staff API, on a combined process.
   *
   * The interceptor is registered only where member routes are served, which on
   * `APP_SURFACE=admin` means not at all — but `all` serves both, and the portal forwards the
   * headers it was given. Without this, a staff member whose browser or BFF passed along an
   * `x-app-version` from anywhere was answered 426 on an admin screen, told to update an app they
   * are not using. Found by the e2e, which sends exactly that.
   */
  '/admin/',
];

/**
 * 426, which Nest's `HttpStatus` does not carry.
 *
 * Written out with its name rather than cast inline: a bare `426 as never` in a throw is a number
 * the next reader has to look up, and this one is the status the whole force-update contract is
 * keyed on.
 */
const UPGRADE_REQUIRED = 426 as HttpStatus;

/**
 * Refuses a member request from a build below the forced floor, with 426.
 *
 * The app's own launch check is what should catch this; the interceptor is for the case it does
 * not — a client that cached a stale policy, one that ignored the answer, or a build old enough
 * not to ask. Which means it has to be cheap: the policy is one 60-second-cached config read, and
 * a request with no version header is never refused.
 *
 * Registered only where member routes are served. A staff request has no `x-app-version` and the
 * admin portal is not a build anybody updates from a store.
 */
@Injectable()
export class AppVersionInterceptor implements NestInterceptor {
  constructor(private readonly policy: AppPolicyService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<Request>();
    const version = header(request, 'x-app-version');

    // No version, no verdict. The web client sends none, and refusing a request over a header we
    // cannot read locks somebody out of something they cannot fix.
    if (!version) return next.handle();

    const path = request.path ?? request.url ?? '';

    if (ALWAYS_ALLOWED.some(allowed => path.includes(allowed))) return next.handle();

    const platform = platformOf(request);
    const decision = await this.policy.decide(platform, version);

    if (decision.status !== 'FORCE_UPDATE') return next.handle();

    throw new ApiException(UPGRADE_REQUIRED, ApiErrorCode.APP_UPDATE_REQUIRED, 'Update required', {
      // The store link travels with the refusal, so a client that was not asking about versions
      // still has somewhere to send the member.
      data: { storeUrl: decision.storeUrl, latest: decision.latest, message: decision.message },
    });
  }
}

const header = (request: Request, name: string): string | null => {
  const value = request.headers[name];

  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

/**
 * Which store the caller came from.
 *
 * Read off `req.deviceInfo`, which `DeviceInfoMiddleware` has already resolved from
 * `x-client-platform` and, failing that, the user agent — the same value the session row records,
 * so the gate and the adoption table are talking about the same platform.
 *
 * `WEB` and anything unknown answer null, and a null platform is **never** forced to update: there
 * is no store to send them to, and the web client has no build to update.
 */
const platformOf = (request: Request): string | null => {
  const resolved = (request as Request & { deviceInfo?: { devicePlatform?: string } }).deviceInfo
    ?.devicePlatform;

  return resolved === 'IOS' || resolved === 'ANDROID' ? resolved : null;
};
