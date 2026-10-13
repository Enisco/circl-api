import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Request } from 'express';
import { Observable } from 'rxjs';
import { AuthenticatedUser, DeviceInfo } from '@/common';
import { MemberActivityService } from './member-activity.service';

/**
 * Notes that a member was here, on every authenticated member request.
 *
 * An interceptor rather than something each controller remembers to call: the question it answers
 * is "were they here", and any endpoint is evidence of that. Scattering the call would mean the
 * numbers depended on which routes somebody had thought about.
 *
 * Three things it deliberately skips. Admin requests, because staff are not members and are
 * excluded from every member metric. Unauthenticated requests, because there is nobody to record.
 * And anything the service's own fifteen-minute gate has already counted — which is most requests,
 * so the usual cost of this interceptor is one Redis `SET NX` that fails.
 */
@Injectable()
export class MemberActivityInterceptor implements NestInterceptor {
  constructor(private readonly activity: MemberActivityService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as (AuthenticatedUser & { isStaff?: boolean }) | undefined;

    // `path` rather than the route pattern: the admin surface is the whole `/admin` prefix, and a
    // pattern-based check would miss anything mounted outside a controller.
    if (!user?.id || user.isStaff || request.path.includes('/admin/')) return next.handle();

    const device = request['deviceInfo'] as DeviceInfo | undefined;

    // No city here. It is looked up by the service, on the one request in fifteen minutes that
    // actually writes — the authenticated user does not carry a profile, so reading one from it
    // gave undefined every time and quietly left the city column empty.
    this.activity.record({
      userId: user.id,
      platform: device?.devicePlatform ?? null,
      appVersion: device?.appVersion ?? null,
      // The session this token was minted for, so the row the filter bar reads for "which builds
      // are still in the wild" moves with real use rather than only with sign-in and refresh
      // (B21). Optional, because a token minted before the claim existed does not carry one.
      sessionId: user.sessionId ?? null,
    });

    return next.handle();
  }
}
