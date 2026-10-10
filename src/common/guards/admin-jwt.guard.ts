import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators';
import { ApiErrorCode } from '../constants/api-error-code.constant';
import { ApiException } from '../exceptions/api.exception';

/**
 * Authenticates an admin request against the `admin-jwt` strategy.
 *
 * `@Public()` is honoured so the sign-in endpoints can sit on the same controller stack as
 * everything else: they still pass the trusted-client guard, which is what keeps them off the open
 * internet, and the permission guard treats a public route as having nothing to authorise.
 */
@Injectable()
export class AdminJwtGuard extends AuthGuard('admin-jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    return super.canActivate(context);
  }

  handleRequest<T>(error: unknown, user: T): T {
    // The strategy's own exception, not a flattened one. It distinguishes "this session is gone"
    // from "this access token expired", and the portal does different things with each: the first
    // logs the person out, the second is refreshed once and retried.
    if (error instanceof ApiException) throw error;

    if (error || !user) {
      throw (
        error ??
        ApiException.unauthorized('Sign in to the admin portal.', ApiErrorCode.UNAUTHORIZED)
      );
    }

    return user;
  }
}
