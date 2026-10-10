import { Injectable } from '@nestjs/common';
import { AdminReasonCode, AdminSessionRevokeReason, Prisma } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException, buildPageMeta } from '@/common';
import { AuditService } from '../audit/audit.service';
import { AdminPrincipal } from '../common/admin-principal';
import { AdminPolicyService } from '../common/admin-policy.service';
import { AdminInviteService, InviteView } from '../auth/admin-invite.service';
import { AdminSessionService } from '../auth/admin-session.service';
import { AdminMeService, AdminSessionView } from './admin-me.service';
import { AdminPermissionService } from '../auth/admin-permission.service';

export interface StaffMember {
  id: string;
  firstName: string;
  lastName: string | null;
  /** Unmasked: a colleague's work address, shown to people who may manage the team. */
  email: string;
  avatarUrl: string | null;
  role: string;
  status: 'ACTIVE' | 'PENDING' | 'DEACTIVATED';
  mfaEnabled: boolean;
  lastActiveAt: string | null;
  createdAt: string;
  invitedBy: { id: string; name: string; role: string } | null;
  /** The object-level rules, evaluated for the caller, so the UI can disable what it must not offer. */
  canManage: boolean;
  /** Only on PENDING rows that are outstanding invitations rather than accounts. */
  inviteId?: string;
}

interface ListQuery {
  page: number;
  perPage: number;
  status?: StaffMember['status'];
  role?: string;
  q?: string;
}

/**
 * The reason a staff action was taken, already checked (`ReasonedDto.assertReasoned`).
 *
 * Taken as a checked value rather than as the raw DTO so that the service cannot be called without
 * one: a signature of `{ reasonCode?: string }` is a signature that compiles with the reason left
 * out, and the entry it writes then looks complete and explains nothing.
 */
type Reason = { reasonCode: AdminReasonCode; policySubtype: string | null; note: string | null };

@Injectable()
export class AdminTeamService {
  constructor(
    private readonly database: PrismaService,
    private readonly audit: AuditService,
    private readonly policy: AdminPolicyService,
    private readonly invites: AdminInviteService,
    private readonly sessions: AdminSessionService,
    private readonly me: AdminMeService,
    private readonly permissions: AdminPermissionService,
  ) {}

  /**
   * The team, which is two different things in one list: accounts, and invitations nobody has
   * accepted yet. The second kind has no user row to sort or search by, so they are assembled
   * separately and shown as `PENDING` rows carrying their `inviteId`.
   */
  async list(actor: AdminPrincipal, query: ListQuery) {
    const where: Prisma.UserWhereInput = {
      isStaff: true,
      ...(query.role ? { userRole: { role: { code: query.role } } } : {}),
      ...(query.status === 'ACTIVE'
        ? { adminCredential: { deactivatedAt: null } }
        : query.status === 'DEACTIVATED'
          ? { adminCredential: { deactivatedAt: { not: null } } }
          : {}),
      ...(query.q
        ? {
            OR: [
              { firstName: { contains: query.q, mode: 'insensitive' } },
              { lastName: { contains: query.q, mode: 'insensitive' } },
              { email: { equals: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const pendingInvites =
      query.status === 'ACTIVE' || query.status === 'DEACTIVATED'
        ? []
        : (await this.invites.list('LIVE')).filter(
            invite => !query.role || invite.role === query.role,
          );

    const [rows, totalAccounts] = await Promise.all([
      query.status === 'PENDING'
        ? Promise.resolve([])
        : this.database.user.findMany({
            where,
            orderBy: [{ firstName: 'asc' }, { id: 'asc' }],
            skip: (query.page - 1) * query.perPage,
            take: query.perPage,
            select: this.selection(),
          }),
      query.status === 'PENDING' ? Promise.resolve(0) : this.database.user.count({ where }),
    ]);

    const data = [
      ...rows.map(row => this.view(actor, row)),
      ...(query.page === 1 ? pendingInvites.map(invite => this.pendingView(actor, invite)) : []),
    ];

    const counts = await this.counts();

    return {
      data,
      meta: {
        ...buildPageMeta(
          { currentPage: query.page, perPage: query.perPage },
          totalAccounts + pendingInvites.length,
        ),
        counts,
      },
    };
  }

  async get(
    actor: AdminPrincipal,
    id: string,
  ): Promise<StaffMember & { sessions: AdminSessionView[] }> {
    const row = await this.database.user.findFirst({
      where: { id, isStaff: true },
      select: this.selection(),
    });

    if (!row) throw ApiException.notFound('No such staff account.');

    const sessions = await this.sessions.listFor(id);

    return {
      ...this.view(actor, row),
      sessions: sessions.map(session => this.me.sessionView(session, actor.sessionId)),
    };
  }

  /** The role matrix, straight from the seed, so the portal and the API cannot drift apart. */
  async roles() {
    const roles = await this.database.role.findMany({
      where: { isAdmin: true },
      orderBy: { code: 'asc' },
      select: {
        code: true,
        name: true,
        description: true,
        rolePermissions: { select: { permission: { select: { code: true } } } },
      },
    });

    const permissions = await this.database.permission.findMany({
      orderBy: { code: 'asc' },
      select: { code: true, name: true, group: true },
    });

    return {
      roles: roles.map(role => ({
        code: role.code,
        name: role.name,
        description: role.description,
        permissions: role.rolePermissions.map(row => row.permission.code).sort(),
      })),
      permissions: permissions.map(permission => ({
        code: permission.code,
        name: permission.name,
        // The stored group where there is one, else the part before the colon: `members:edit`
        // belongs with `members:read`.
        group: permission.group ?? permission.code.split(':')[0],
      })),
    };
  }

  async changeRole(
    actor: AdminPrincipal,
    targetId: string,
    input: { role: string } & Reason,
  ): Promise<{ staff: StaffMember; auditId: string }> {
    const target = await this.staffOrThrow(targetId);

    this.policy.assertMayActOn(actor, { id: target.id, roleCode: target.roleCode });
    this.policy.assertMayGrant(actor, input.role);

    if (target.roleCode === input.role) {
      throw ApiException.badRequest(ApiErrorCode.VALIDATION_FAILED, 'That is already their role.', {
        details: [{ field: 'role', message: 'No change.' }],
      });
    }

    if (target.deactivatedAt) {
      throw ApiException.conflict(
        ApiErrorCode.INVALID_TRANSITION,
        'That account is deactivated. Reactivate it first.',
      );
    }

    const role = await this.database.role.findUnique({ where: { code: input.role } });

    if (!role?.isAdmin) throw ApiException.notFound('No such staff role.');

    const { auditId } = await this.audit.mutate(
      {
        action: 'team.role_changed',
        targetType: 'STAFF',
        targetId,
        targetLabel: target.email,
        before: { role: target.roleCode },
        after: { role: input.role },
        reasonCode: input.reasonCode,
        policySubtype: input.policySubtype,
        reason: input.note,
      },
      async tx => {
        // Demoting the last super admin would leave nobody able to put it back. Locked inside the
        // transaction, so two concurrent demotions cannot each see the other's account and proceed.
        if (target.roleCode === 'super_admin') {
          await this.policy.assertNotLastSuperAdmin(tx, targetId);
        }

        await tx.userRole.update({ where: { userId: targetId }, data: { roleId: role.id } });

        // A session carries no permissions, but it does carry a role claim, and the permission
        // cache is keyed by role. Revoking forces a fresh sign-in against the new role rather than
        // leaving a window where the old one is still being honoured.
        await tx.adminCredential.update({
          where: { userId: targetId },
          data: { credentialEpoch: { increment: 1 } },
        });
        await this.sessions.revokeAll({
          userId: targetId,
          reason: AdminSessionRevokeReason.ROLE_CHANGED,
          revokedById: actor.id,
          tx,
        });
      },
    );

    await this.permissions.invalidate(input.role);
    await this.permissions.invalidate(target.roleCode);

    return { staff: await this.get(actor, targetId), auditId };
  }

  /**
   * Deactivation: the account stops working now, and the work it was holding goes back to the pool.
   *
   * Unassigning matters as much as the sign-out. A queue item claimed by somebody who has left is
   * invisible to everybody else, so the effect of forgetting it is a report nobody ever looks at.
   */
  async deactivate(
    actor: AdminPrincipal,
    targetId: string,
    input: Reason,
  ): Promise<{ staff: StaffMember; auditId: string; released: number }> {
    const target = await this.staffOrThrow(targetId);

    this.policy.assertMayActOn(actor, { id: target.id, roleCode: target.roleCode });

    if (target.deactivatedAt) {
      throw ApiException.conflict(
        ApiErrorCode.INVALID_TRANSITION,
        'That account is already deactivated.',
      );
    }

    const { result, auditId } = await this.audit.mutate(
      {
        action: 'team.deactivated',
        targetType: 'STAFF',
        targetId,
        targetLabel: target.email,
        reasonCode: input.reasonCode,
        policySubtype: input.policySubtype,
        reason: input.note,
      },
      async tx => {
        if (target.roleCode === 'super_admin') {
          await this.policy.assertNotLastSuperAdmin(tx, targetId);
        }

        await tx.adminCredential.update({
          where: { userId: targetId },
          data: {
            deactivatedAt: new Date(),
            deactivatedById: actor.id,
            credentialEpoch: { increment: 1 },
          },
        });

        await this.invites.supersedeFor(targetId, tx);
        await this.sessions.revokeAll({
          userId: targetId,
          reason: AdminSessionRevokeReason.DEACTIVATED,
          revokedById: actor.id,
          tx,
        });

        return this.releaseWork(tx, targetId);
      },
    );

    return { staff: await this.get(actor, targetId), auditId, released: result };
  }

  async reactivate(
    actor: AdminPrincipal,
    targetId: string,
    input: Reason,
  ): Promise<{ staff: StaffMember; invite: InviteView; auditId: string }> {
    const target = await this.staffOrThrow(targetId);

    this.policy.assertNotSelf(actor, targetId);
    this.policy.assertMayGrant(actor, target.roleCode);

    if (!target.deactivatedAt) {
      throw ApiException.conflict(
        ApiErrorCode.INVALID_TRANSITION,
        'That account is not deactivated.',
      );
    }

    const { result, auditId } = await this.audit.mutate(
      {
        action: 'team.reactivated',
        targetType: 'STAFF',
        targetId,
        targetLabel: target.email,
        reasonCode: input.reasonCode,
        policySubtype: input.policySubtype,
        reason: input.note,
      },
      async tx => {
        // Credentials are not restored, only the account. Coming back needs a fresh password and a
        // fresh authenticator, because whatever was there has been sitting unused and unwatched.
        await tx.adminCredential.update({
          where: { userId: targetId },
          data: { deactivatedAt: null, deactivatedById: null, credentialEpoch: { increment: 1 } },
        });
        await this.invites.supersedeFor(targetId, tx);

        return this.invites.issueFor(actor, targetId, target.email, target.roleId, tx);
      },
    );

    return {
      staff: await this.get(actor, targetId),
      invite: await this.invites.view(result.invite),
      auditId,
    };
  }

  async resetCredentials(
    actor: AdminPrincipal,
    targetId: string,
    input: { scope: 'password' | 'mfa' | 'both' } & Reason,
  ): Promise<{ invite: InviteView | null; auditId: string }> {
    const target = await this.staffOrThrow(targetId);

    this.policy.assertMayActOn(actor, { id: target.id, roleCode: target.roleCode });

    if (target.deactivatedAt) {
      throw ApiException.conflict(
        ApiErrorCode.INVALID_TRANSITION,
        'That account is deactivated. Reactivate it instead.',
      );
    }

    const { result, auditId } = await this.audit.mutate(
      {
        action: 'team.credentials_reset',
        targetType: 'STAFF',
        targetId,
        targetLabel: target.email,
        metadata: { scope: input.scope },
        reasonCode: input.reasonCode,
        policySubtype: input.policySubtype,
        reason: input.note,
      },
      async tx => {
        if (target.roleCode === 'super_admin') {
          await this.policy.assertNotLastSuperAdmin(tx, targetId);
        }

        const clearMfa = input.scope === 'mfa' || input.scope === 'both';

        await tx.adminCredential.update({
          where: { userId: targetId },
          data: {
            ...(clearMfa
              ? {
                  totpSecretEnc: null,
                  totpKeyId: null,
                  totpEnabledAt: null,
                  totpLastUsedStep: null,
                }
              : {}),
            failedAttempts: 0,
            failedMfaAttempts: 0,
            lockedUntil: null,
            // Strands every setup token issued before this moment. Without it, a token somebody
            // obtained before a reset for a suspected compromise would still work afterwards.
            credentialEpoch: { increment: 1 },
          },
        });

        await this.invites.supersedeFor(targetId, tx);
        await this.sessions.revokeAll({
          userId: targetId,
          reason: AdminSessionRevokeReason.CREDENTIAL_RESET,
          revokedById: actor.id,
          tx,
        });

        if (clearMfa) {
          await tx.adminRecoveryCode.deleteMany({ where: { userId: targetId } });
        }

        // A password reset needs a new setup link; an MFA-only reset does not — the next sign-in
        // with the existing password hands back the enrolment path on its own.
        if (input.scope === 'mfa') return null;

        return this.invites.issueFor(actor, targetId, target.email, target.roleId, tx);
      },
    );

    return {
      invite: result ? await this.invites.view(result.invite) : null,
      auditId,
    };
  }

  async revokeSessions(
    actor: AdminPrincipal,
    targetId: string,
    sessionId?: string,
  ): Promise<{ revokedCount: number; auditId: string }> {
    const target = await this.staffOrThrow(targetId);

    this.policy.assertMayActOn(actor, { id: target.id, roleCode: target.roleCode });

    const { result, auditId } = await this.audit.mutate(
      {
        action: 'team.sessions_revoked',
        targetType: 'STAFF',
        targetId,
        targetLabel: target.email,
        metadata: { scope: sessionId ? 'one' : 'all', sessionId: sessionId ?? null },
      },
      async tx => {
        if (sessionId) {
          await this.sessions.revoke(
            sessionId,
            AdminSessionRevokeReason.ADMIN_REVOKED,
            actor.id,
            tx,
          );

          return 1;
        }

        return this.sessions.revokeAll({
          userId: targetId,
          reason: AdminSessionRevokeReason.ADMIN_REVOKED,
          revokedById: actor.id,
          tx,
        });
      },
    );

    return { revokedCount: result, auditId };
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  /**
   * Returns everything this person was holding to the unassigned pool.
   *
   * Audited as part of the deactivation entry rather than separately: it is one decision with
   * several consequences, and splitting it would make the trail harder to read, not easier.
   */
  private async releaseWork(tx: Prisma.TransactionClient, userId: string): Promise<number> {
    const [queue, guard] = await Promise.all([
      tx.moderationQueueItem.updateMany({
        where: { assignedToId: userId, state: { not: 'RESOLVED' } },
        data: { assignedToId: null },
      }),
      tx.guardThread.updateMany({ where: { assignedToId: userId }, data: { assignedToId: null } }),
    ]);

    return queue.count + guard.count;
  }

  private selection() {
    return {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      createdAt: true,
      adminProfile: { select: { avatar: true } },
      adminCredential: {
        select: {
          deactivatedAt: true,
          totpEnabledAt: true,
          lastActiveAt: true,
          invitedById: true,
        },
      },
      userRole: { select: { roleId: true, role: { select: { code: true } } } },
    } satisfies Prisma.UserSelect;
  }

  private view(
    actor: AdminPrincipal,
    row: Prisma.UserGetPayload<{ select: ReturnType<AdminTeamService['selection']> }>,
  ): StaffMember {
    const roleCode = row.userRole?.role.code ?? 'unknown';

    return {
      id: row.id,
      firstName: row.firstName,
      lastName: row.lastName,
      email: row.email,
      avatarUrl: row.adminProfile?.avatar ?? null,
      role: roleCode,
      status: row.adminCredential?.deactivatedAt
        ? 'DEACTIVATED'
        : row.adminCredential?.totpEnabledAt
          ? 'ACTIVE'
          : // Invited, password set, authenticator not yet added: the account exists and cannot
            // sign in, which is neither active nor deactivated.
            'PENDING',
      mfaEnabled: Boolean(row.adminCredential?.totpEnabledAt),
      lastActiveAt: row.adminCredential?.lastActiveAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      invitedBy: null,
      canManage: this.policy.canManage(actor, { id: row.id, roleCode }),
    };
  }

  private pendingView(actor: AdminPrincipal, invite: InviteView): StaffMember {
    return {
      id: invite.id,
      firstName: invite.email.split('@')[0],
      lastName: null,
      email: invite.email,
      avatarUrl: null,
      role: invite.role,
      status: 'PENDING',
      mfaEnabled: false,
      lastActiveAt: null,
      createdAt: invite.createdAt,
      invitedBy: invite.invitedBy,
      canManage: actor.permissions.has('team:manage'),
      inviteId: invite.id,
    };
  }

  private async counts() {
    const [active, deactivated, pendingAccounts, liveInvites] = await Promise.all([
      this.database.user.count({
        where: {
          isStaff: true,
          adminCredential: { deactivatedAt: null, totpEnabledAt: { not: null } },
        },
      }),
      this.database.user.count({
        where: { isStaff: true, adminCredential: { deactivatedAt: { not: null } } },
      }),
      this.database.user.count({
        where: { isStaff: true, adminCredential: { deactivatedAt: null, totpEnabledAt: null } },
      }),
      this.database.adminInvite.count({ where: { acceptedAt: null, revokedAt: null } }),
    ]);

    return { ACTIVE: active, PENDING: pendingAccounts + liveInvites, DEACTIVATED: deactivated };
  }

  private async staffOrThrow(id: string) {
    const row = await this.database.user.findFirst({
      where: { id, isStaff: true },
      select: {
        id: true,
        email: true,
        adminCredential: { select: { deactivatedAt: true } },
        userRole: { select: { roleId: true, role: { select: { code: true } } } },
      },
    });

    if (!row?.userRole) throw ApiException.notFound('No such staff account.');

    return {
      id: row.id,
      email: row.email,
      roleId: row.userRole.roleId,
      roleCode: row.userRole.role.code,
      deactivatedAt: row.adminCredential?.deactivatedAt ?? null,
    };
  }
}
