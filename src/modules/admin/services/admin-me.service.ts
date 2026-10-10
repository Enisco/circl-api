import { Injectable } from '@nestjs/common';
import { AdminSession, AdminSessionRevokeReason } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException } from '@/common';
import { AuditService } from '../audit/audit.service';
import { AdminPrincipal } from '../common/admin-principal';
import { AdminPasswordService } from '../auth/admin-password.service';
import { AdminRecoveryCodeService } from '../auth/admin-recovery-code.service';
import { AdminTotpService } from '../auth/admin-totp.service';
import { AdminSessionService } from '../auth/admin-session.service';
import { AdminMailService } from '../auth/admin-mail.service';

export interface AdminMeView {
  id: string;
  firstName: string;
  lastName: string | null;
  /** Unmasked: it is their own address. */
  email: string;
  avatarUrl: string | null;
  role: string;
  permissions: string[];
  mfaEnabled: boolean;
}

export interface AdminSessionView {
  id: string;
  ip: string;
  userAgent: string;
  createdAt: string;
  lastUsedAt: string;
  absoluteExpiresAt: string;
  current: boolean;
}

/** A staff member's own account: the one place where acting on yourself is the point. */
@Injectable()
export class AdminMeService {
  constructor(
    private readonly database: PrismaService,
    private readonly audit: AuditService,
    private readonly passwords: AdminPasswordService,
    private readonly totp: AdminTotpService,
    private readonly recoveryCodes: AdminRecoveryCodeService,
    private readonly sessions: AdminSessionService,
    private readonly mail: AdminMailService,
  ) {}

  async me(actor: AdminPrincipal): Promise<AdminMeView> {
    const user = await this.database.user.findUniqueOrThrow({
      where: { id: actor.id },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        adminProfile: { select: { avatar: true } },
        adminCredential: { select: { totpEnabledAt: true } },
      },
    });

    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      avatarUrl: user.adminProfile?.avatar ?? null,
      role: actor.roleCode,
      // For the UI only. Every request re-resolves these server-side, so a stale copy in the
      // browser cannot grant anything (S5.4).
      permissions: [...actor.permissions].sort(),
      mfaEnabled: user.adminCredential?.totpEnabledAt !== null,
    };
  }

  async updateProfile(
    actor: AdminPrincipal,
    input: { firstName?: string; lastName?: string; avatarMediaId?: string | null },
  ): Promise<{ me: AdminMeView; auditId: string }> {
    if (input.avatarMediaId !== undefined) {
      // Said plainly rather than accepted and ignored: a field that is silently dropped looks like
      // a save that worked.
      throw ApiException.badRequest(
        ApiErrorCode.NOT_AVAILABLE_YET,
        'Staff photo upload has not shipped yet.',
      );
    }

    const before = await this.database.user.findUniqueOrThrow({
      where: { id: actor.id },
      select: { firstName: true, lastName: true },
    });

    const { auditId } = await this.audit.mutate(
      {
        action: 'staff.profile_updated',
        targetType: 'STAFF',
        targetId: actor.id,
        before,
        after: {
          firstName: input.firstName ?? before.firstName,
          lastName: input.lastName ?? before.lastName,
        },
      },
      async tx =>
        tx.user.update({
          where: { id: actor.id },
          data: {
            ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
            ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
          },
        }),
    );

    return { me: await this.me(actor), auditId };
  }

  /**
   * Changes the password, having proved it is really them.
   *
   * Both factors again, not just the old password: the threat is a session somebody walked away
   * from, and the old password is written in the browser's password manager on that same machine.
   * Every other session is then signed out, because a password change is what you do when you
   * think somebody else has it.
   */
  async changePassword(
    actor: AdminPrincipal,
    input: { currentPassword: string; newPassword: string; code: string },
  ): Promise<{ auditId: string }> {
    // The new password is judged before the authenticator code is spent. The other way round, a
    // password that broke the policy burned the code with it, so every correction needed a fresh
    // thirty-second window — a punishment for mistyping.
    await this.passwords.assertAcceptable(input.newPassword, {
      email: actor.email,
      firstName: actor.firstName,
      lastName: actor.lastName,
    });

    await this.reauthenticate(actor, input.currentPassword, input.code);

    const passwordHash = await this.passwords.hash(input.newPassword);
    const { auditId } = await this.audit.mutate(
      { action: 'auth.password_changed', targetType: 'STAFF', targetId: actor.id },
      async tx => {
        await tx.adminCredential.update({
          where: { userId: actor.id },
          data: { passwordHash, passwordUpdatedAt: new Date() },
        });

        // Keeps the current one: signing yourself out of the change you just made is not a
        // security property, it is an annoyance.
        await this.sessions.revokeAll({
          userId: actor.id,
          reason: AdminSessionRevokeReason.CREDENTIAL_RESET,
          revokedById: actor.id,
          except: actor.sessionId,
          tx,
        });
      },
    );

    await this.mail.passwordChanged(actor.email);

    return { auditId };
  }

  async regenerateRecoveryCodes(
    actor: AdminPrincipal,
    input: { password: string; code: string },
  ): Promise<{ recoveryCodes: string[]; auditId: string }> {
    await this.reauthenticate(actor, input.password, input.code);

    const { result, auditId } = await this.audit.mutate(
      { action: 'auth.recovery_codes_regenerated', targetType: 'STAFF', targetId: actor.id },
      async tx => this.recoveryCodes.issue(actor.id, tx),
    );

    return { recoveryCodes: result, auditId };
  }

  async sessions_(actor: AdminPrincipal): Promise<AdminSessionView[]> {
    const sessions = await this.sessions.listFor(actor.id);

    return sessions.map(session => this.sessionView(session, actor.sessionId));
  }

  async revokeSession(actor: AdminPrincipal, sessionId: string): Promise<{ auditId: string }> {
    if (sessionId === actor.sessionId) {
      throw ApiException.conflict(
        ApiErrorCode.CANNOT_REVOKE_CURRENT_SESSION,
        'That is this session. Sign out instead.',
      );
    }

    const session = await this.database.adminSession.findFirst({
      where: { id: sessionId, userId: actor.id, revokedAt: null },
      select: { id: true },
    });

    if (!session) throw ApiException.notFound('No such session.');

    const { auditId } = await this.audit.mutate(
      {
        action: 'auth.sessions_revoked',
        targetType: 'STAFF',
        targetId: actor.id,
        metadata: { scope: 'one', sessionId },
      },
      async tx =>
        this.sessions.revoke(sessionId, AdminSessionRevokeReason.ADMIN_REVOKED, actor.id, tx),
    );

    return { auditId };
  }

  async revokeOtherSessions(
    actor: AdminPrincipal,
  ): Promise<{ revokedCount: number; auditId: string }> {
    const { result, auditId } = await this.audit.mutate(
      {
        action: 'auth.sessions_revoked',
        targetType: 'STAFF',
        targetId: actor.id,
        metadata: { scope: 'others' },
      },
      async tx =>
        this.sessions.revokeAll({
          userId: actor.id,
          reason: AdminSessionRevokeReason.ADMIN_REVOKED,
          revokedById: actor.id,
          except: actor.sessionId,
          tx,
        }),
    );

    return { revokedCount: result, auditId };
  }

  sessionView(session: AdminSession, currentId: string): AdminSessionView {
    return {
      id: session.id,
      // Narrowed to the /24. Precise enough to tell "somewhere else entirely" from "the office",
      // which is the question being asked of this screen, and not precise enough to locate anyone.
      ip: this.maskIp(session.ip),
      userAgent: session.userAgent,
      createdAt: session.createdAt.toISOString(),
      lastUsedAt: session.lastUsedAt.toISOString(),
      absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
      current: session.id === currentId,
    };
  }

  private maskIp(ip: string): string {
    if (ip.includes(':')) {
      const groups = ip.split(':');

      return `${groups.slice(0, 3).join(':')}:x`;
    }

    const octets = ip.split('.');

    return octets.length === 4 ? `${octets.slice(0, 3).join('.')}.x` : ip;
  }

  /**
   * Password and a live authenticator code, for a change to your own credentials.
   *
   * 422 rather than 401 on failure: a 401 would make the portal think the session had gone and log
   * the person out mid-dialog, when what actually happened is that they mistyped.
   */
  private async reauthenticate(
    actor: AdminPrincipal,
    password: string,
    code: string,
  ): Promise<void> {
    const credential = await this.database.adminCredential.findUnique({
      where: { userId: actor.id },
    });

    if (!credential?.totpSecretEnc) throw this.wrongCredentials();
    if (!(await this.passwords.verify(credential.passwordHash, password))) {
      throw this.wrongCredentials();
    }

    const secret = this.totp.decrypt(credential.totpSecretEnc);
    const result = await this.totp.check(secret, code, credential.totpLastUsedStep);

    if (!result.valid) throw this.wrongCredentials();

    // Recorded so the same code cannot re-authenticate a second change.
    await this.database.adminCredential.update({
      where: { userId: actor.id },
      data: { totpLastUsedStep: result.step !== null ? BigInt(result.step) : undefined },
    });
  }

  private wrongCredentials() {
    return ApiException.unprocessable(
      ApiErrorCode.INVALID_CREDENTIALS,
      'That password or code is not right.',
    );
  }
}
