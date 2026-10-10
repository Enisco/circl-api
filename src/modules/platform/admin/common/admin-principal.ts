import { SetMetadata } from '@nestjs/common';

/** Who is making an admin request, as every admin service sees them. */
export interface AdminPrincipal {
  id: string;
  email: string;
  firstName: string;
  lastName: string | null;
  roleCode: string;
  /** Resolved server-side from the role on every request. Never read from the token. */
  permissions: Set<string>;
  sessionId: string;
}

export const ADMIN_PERMISSIONS_KEY = 'adminPermissions';
export const ADMIN_ANY_PERMISSION_KEY = 'adminAnyPermission';
export const ADMIN_AUTHENTICATED_KEY = 'adminAuthenticated';

/** Every one of these permissions is required. */
export const AdminPermissions = (...permissions: string[]) =>
  SetMetadata(ADMIN_PERMISSIONS_KEY, permissions);

/** Any one of these is enough. For scoped reads, where three permissions grant three views. */
export const AdminAnyPermission = (...permissions: string[]) =>
  SetMetadata(ADMIN_ANY_PERMISSION_KEY, permissions);

/**
 * Open to any active staff member, declared on purpose.
 *
 * Needed because the permission guard denies by default: a route with no metadata is refused
 * rather than allowed, so "anyone signed in" has to be said out loud. That is the whole point —
 * the failure mode of the old guard was a route nobody had thought about being open to everybody.
 */
export const AdminAuthenticated = () => SetMetadata(ADMIN_AUTHENTICATED_KEY, true);
