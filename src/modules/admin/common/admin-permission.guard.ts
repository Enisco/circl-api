import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { ApiErrorCode, ApiException, IS_PUBLIC_KEY } from '@/common';
import {
  ADMIN_ANY_PERMISSION_KEY,
  ADMIN_AUTHENTICATED_KEY,
  ADMIN_PERMISSIONS_KEY,
  AdminPrincipal,
} from './admin-principal';

/**
 * Deny by default.
 *
 * The member `PermissionGuard` returns true when a route declares no permissions, so a handler
 * nobody remembered to annotate is open to every signed-in caller — and it short-circuits on
 * `manage:all`, a wildcard one role assignment away from being live (B4). Neither is survivable on
 * the admin surface, where the thing behind the route is somebody's private messages.
 *
 * So: no metadata, no access. "Any signed-in member of staff" has to be said out loud with
 * `@AdminAuthenticated()`, which makes it a decision in a diff rather than an omission. A startup
 * check refuses to boot if any admin route lacks all three (`admin-route-audit.ts`), so the
 * omission cannot reach a deployment in the first place.
 */
@Injectable()
export class AdminPermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];

    // Sign-in and invite acceptance have nobody to authorise yet. They are not exempt from the
    // trusted-client guard, which is the control that keeps them off the open internet.
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const required = this.reflector.getAllAndOverride<string[]>(ADMIN_PERMISSIONS_KEY, targets);
    const anyOf = this.reflector.getAllAndOverride<string[]>(ADMIN_ANY_PERMISSION_KEY, targets);
    const authenticatedOnly = this.reflector.getAllAndOverride<boolean>(
      ADMIN_AUTHENTICATED_KEY,
      targets,
    );

    const request = context.switchToHttp().getRequest<Request>();
    const principal = request.user as AdminPrincipal | undefined;

    if (!principal?.permissions) {
      throw ApiException.forbidden(ApiErrorCode.FORBIDDEN, 'You cannot do that.');
    }

    if (required?.length) {
      const holdsAll = required.every(permission => principal.permissions.has(permission));

      if (!holdsAll) throw this.refuse(required);

      return true;
    }

    if (anyOf?.length) {
      const holdsOne = anyOf.some(permission => principal.permissions.has(permission));

      if (!holdsOne) throw this.refuse(anyOf);

      return true;
    }

    if (authenticatedOnly) return true;

    // Not an authorisation failure so much as a programming one, and it fails closed. The startup
    // check should have caught it; if something reaches here, nobody gets through.
    throw ApiException.forbidden(
      ApiErrorCode.FORBIDDEN,
      'This endpoint declares no permissions and is therefore unavailable.',
    );
  }

  /** Names what was needed, which is useful to the portal and tells an attacker nothing new. */
  private refuse(permissions: string[]) {
    return ApiException.forbidden(ApiErrorCode.FORBIDDEN, 'You cannot do that.', {
      data: { requires: permissions },
    });
  }
}
