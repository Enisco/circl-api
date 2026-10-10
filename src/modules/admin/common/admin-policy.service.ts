import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException } from '@/common';
import { AdminPrincipal } from './admin-principal';

export const ADMIN_ROLE_CODES = ['super_admin', 'manager', 'trust_safety', 'support'] as const;
export type AdminRoleCode = (typeof ADMIN_ROLE_CODES)[number];

/** Which roles each role may hand out. A role cannot grant what it does not itself hold. */
const GRANTABLE: Record<string, AdminRoleCode[]> = {
  super_admin: ['super_admin', 'manager', 'trust_safety', 'support'],
  manager: ['manager', 'trust_safety', 'support'],
};

/**
 * The object-level rules (§3.6), in one place.
 *
 * They are the rules that a permission check cannot express: `team:manage` says you may change
 * roles, not that you may change a super admin's, nor your own, nor the last one. Each of these
 * is a way a staff account could be used to widen its own reach or to lock everybody out, so they
 * are enforced in a service the callers share rather than restated at each call site.
 */
@Injectable()
export class AdminPolicyService {
  constructor(private readonly database: PrismaService) {}

  /** R1: inviting or assigning a role the actor may not grant. */
  assertMayGrant(actor: AdminPrincipal, role: string): void {
    const grantable = GRANTABLE[actor.roleCode] ?? [];

    if (!grantable.includes(role as AdminRoleCode)) {
      throw ApiException.forbidden(
        ApiErrorCode.ROLE_ESCALATION_FORBIDDEN,
        'You cannot grant that role.',
      );
    }
  }

  /** R2: a manager may not act on a super admin. */
  assertMayActOn(actor: AdminPrincipal, target: { id: string; roleCode: string }): void {
    this.assertNotSelf(actor, target.id);

    if (actor.roleCode !== 'super_admin' && target.roleCode === 'super_admin') {
      throw ApiException.forbidden(
        ApiErrorCode.TARGET_PROTECTED,
        'Only a super admin can act on another super admin.',
      );
    }
  }

  /**
   * R3: nobody acts on themselves through Team.
   *
   * Not merely a guard against mistakes. Self-service demotion and reactivation are the two steps
   * an attacker with one account needs to cover their tracks, and own-password and own-sessions
   * already have their own endpoints under `/admin/me`, where re-authentication is required.
   */
  assertNotSelf(actor: AdminPrincipal, targetId: string): void {
    if (actor.id === targetId) {
      throw ApiException.forbidden(
        ApiErrorCode.CANNOT_ACT_ON_SELF,
        'Use your own settings for that.',
      );
    }
  }

  /**
   * R4: the platform must keep at least one active super admin.
   *
   * Locked with `FOR UPDATE` on the super admin role rows, because the dangerous case is two
   * concurrent demotions each seeing two super admins and each believing it is leaving one behind.
   */
  async assertNotLastSuperAdmin(tx: Prisma.TransactionClient, targetId: string): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ user_id: string }>>`
      SELECT ur.user_id
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      JOIN users u ON u.id = ur.user_id
      LEFT JOIN admin_credentials ac ON ac.user_id = u.id
      WHERE r.code = 'super_admin'
        AND u.is_staff = true
        AND u.status = 'ACTIVE'
        AND ac.deactivated_at IS NULL
      FOR UPDATE OF ur
    `;

    const others = rows.filter(row => row.user_id !== targetId);

    if (!others.length) {
      throw ApiException.conflict(
        ApiErrorCode.LAST_SUPER_ADMIN,
        'That would leave no active super admin. Promote somebody else first.',
      );
    }
  }

  /**
   * R5: member endpoints refuse staff targets — staff are managed only through Team.
   *
   * An anonymised or deleted account is refused by the same rule, and for the same reason the
   * member list excludes them (§5.5): there is no personal data left to act on, and serving the
   * husk of one invites somebody to suspend, warn or edit a person who no longer exists. A 404
   * rather than a 403 in every case, because a 403 confirms the id belongs to somebody.
   */
  async assertIsMember(userId: string): Promise<void> {
    const user = await this.database.user.findUnique({
      where: { id: userId },
      select: { isStaff: true, isAnonymised: true, deletedAt: true },
    });

    if (!user || user.isStaff || user.isAnonymised || user.deletedAt) {
      throw ApiException.notFound('No such member.');
    }
  }

  /** Whether the caller may manage this staff row, so the portal can grey out what it must not offer. */
  canManage(actor: AdminPrincipal, target: { id: string; roleCode: string }): boolean {
    if (!actor.permissions.has('team:manage')) return false;
    if (actor.id === target.id) return false;
    if (actor.roleCode !== 'super_admin' && target.roleCode === 'super_admin') return false;

    return true;
  }
}
