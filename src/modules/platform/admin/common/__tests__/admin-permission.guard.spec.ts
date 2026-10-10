import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiErrorCode } from '@/common';
import { AdminPermissionGuard } from '../admin-permission.guard';
import {
  ADMIN_ANY_PERMISSION_KEY,
  ADMIN_AUTHENTICATED_KEY,
  ADMIN_PERMISSIONS_KEY,
  AdminPrincipal,
} from '../admin-principal';

const principal = (permissions: string[]): AdminPrincipal => ({
  id: 'staff-1',
  email: 'staff@circl.test',
  firstName: 'Ada',
  lastName: null,
  roleCode: 'trust_safety',
  permissions: new Set(permissions),
  sessionId: 'session-1',
});

const contextFor = (user: AdminPrincipal | undefined): ExecutionContext =>
  ({
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as unknown as ExecutionContext;

/** Metadata as the reflector would read it off a handler. */
const metadata = (declared: Record<string, unknown>) =>
  ({ getAllAndOverride: (key: string) => declared[key] }) as unknown as Reflector;

/** `ApiException` carries the code as a property and inside its response body. */
const codeOf = (thrown: unknown): string | undefined =>
  (thrown as { code?: string })?.code;

/**
 * The guard this replaces allowed any route that declared nothing, and short-circuited on a
 * wildcard permission. Both are survivable on a member route and neither is on the admin surface,
 * where what sits behind the handler is somebody's private messages.
 */
describe('AdminPermissionGuard', () => {
  it('refuses a route that declares nothing, even to a staff member who holds everything', () => {
    const guard = new AdminPermissionGuard(metadata({}));

    expect(() => guard.canActivate(contextFor(principal(['members:read', 'team:manage'])))).toThrow();
  });

  it('refuses a route that declares nothing even when the declaration is an empty list', () => {
    const guard = new AdminPermissionGuard(metadata({ [ADMIN_PERMISSIONS_KEY]: [] }));

    expect(() => guard.canActivate(contextFor(principal(['members:read'])))).toThrow();
  });

  it('ignores a wildcard: manage:all is not a permission any more', () => {
    const guard = new AdminPermissionGuard(
      metadata({ [ADMIN_PERMISSIONS_KEY]: ['members:suspend'] }),
    );

    expect(() => guard.canActivate(contextFor(principal(['manage:all'])))).toThrow();
  });

  it('requires every declared permission, not merely one of them', () => {
    const guard = new AdminPermissionGuard(
      metadata({ [ADMIN_PERMISSIONS_KEY]: ['members:read', 'members:pii_reveal'] }),
    );

    expect(() => guard.canActivate(contextFor(principal(['members:read'])))).toThrow();
    expect(
      guard.canActivate(contextFor(principal(['members:read', 'members:pii_reveal']))),
    ).toBe(true);
  });

  it('accepts any one where the route says any', () => {
    const guard = new AdminPermissionGuard(
      metadata({ [ADMIN_ANY_PERMISSION_KEY]: ['audit:read', 'audit:read_self'] }),
    );

    expect(guard.canActivate(contextFor(principal(['audit:read_self'])))).toBe(true);
    expect(() => guard.canActivate(contextFor(principal(['members:read'])))).toThrow();
  });

  it('lets any signed-in staff member through only where that is said out loud', () => {
    const guard = new AdminPermissionGuard(metadata({ [ADMIN_AUTHENTICATED_KEY]: true }));

    expect(guard.canActivate(contextFor(principal([])))).toBe(true);
  });

  it('refuses when nobody is authenticated, whatever the route declares', () => {
    const guard = new AdminPermissionGuard(metadata({ [ADMIN_AUTHENTICATED_KEY]: true }));

    expect(() => guard.canActivate(contextFor(undefined))).toThrow();
  });

  it('names what was needed, which helps the portal and tells an attacker nothing new', () => {
    const guard = new AdminPermissionGuard(
      metadata({ [ADMIN_PERMISSIONS_KEY]: ['team:manage'] }),
    );

    let thrown: unknown = null;

    try {
      guard.canActivate(contextFor(principal(['team:read'])));
    } catch (error) {
      thrown = error;
    }

    expect(codeOf(thrown)).toBe(ApiErrorCode.FORBIDDEN);
    expect(JSON.stringify((thrown as { data?: unknown }).data)).toContain('team:manage');
  });
});
