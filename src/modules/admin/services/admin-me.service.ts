import { Injectable } from '@nestjs/common';
import { AdminSession, AdminSessionRevokeReason } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException, toJson } from '@/common';
import { AuditService } from '../audit/audit.service';
import { AdminPrincipal } from '../common/admin-principal';
import { AdminPasswordService } from '../auth/admin-password.service';
import { AdminRecoveryCodeService } from '../auth/admin-recovery-code.service';
import { AdminOtpService } from '../auth/admin-otp.service';
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
  /**
   * Always true for an account that can sign in.
   *
   * Kept in the shape rather than dropped, because the portal shows it — but it is no longer a
   * property of the account. Every sign-in needs a code emailed to this address, so there is no
   * second factor to turn on and none to be missing, and a screen offering to set one up would be
   * offering something that does not exist.
   */
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
    private readonly otp: AdminOtpService,
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
        adminCredential: { select: { deactivatedAt: true } },
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
      mfaEnabled: user.adminCredential?.deactivatedAt === null,
    };
  }

  /**
   * §5.2's preferences, with the defaults filled in.
   *
   * Defaults live here rather than in the column so a staff member who has never opened the
   * settings screen reads the same shape as one who has — the portal binds three switches and a
   * theme, and a missing key is a switch with no state to draw.
   *
   * All three alerts default **on**: the two that matter are an urgent report and a critical Guard
   * case, and somebody who has never visited this screen should not be the last to hear about
   * either.
   */
  async preferences(actor: AdminPrincipal): Promise<AdminPreferencesView> {
    const row = await this.database.adminProfile.findUnique({
      where: { userId: actor.id },
      select: { preferences: true },
    });

    return withDefaults(row?.preferences);
  }

  /**
   * Writes them, merging `alerts` rather than replacing it.
   *
   * The screen has three switches and sends the one that moved. Replacing would mean saving one
   * toggle silently turns the other two off — and for `criticalGuard` that is somebody who stops
   * being told about safeguarding cases with no way to know it happened.
   */
  async setPreferences(
    actor: AdminPrincipal,
    input: {
      theme?: 'light' | 'dark' | 'system';
      alerts?: { urgentReports?: boolean; criticalGuard?: boolean; assignedToMe?: boolean };
    },
  ): Promise<AdminPreferencesView> {
    const current = await this.preferences(actor);
    const next: AdminPreferencesView = {
      theme: input.theme ?? current.theme,
      alerts: {
        urgentReports: input.alerts?.urgentReports ?? current.alerts.urgentReports,
        criticalGuard: input.alerts?.criticalGuard ?? current.alerts.criticalGuard,
        assignedToMe: input.alerts?.assignedToMe ?? current.alerts.assignedToMe,
      },
    };

    await this.database.adminProfile.upsert({
      where: { userId: actor.id },
      update: { preferences: toJson(next) },
      // A staff member may have no profile row yet: it is created on first avatar or, now, on
      // first preference. `upsert` rather than requiring one to exist.
      create: { userId: actor.id, preferences: toJson(next) },
    });

    // Deliberately **not** audited. The trail is read to answer "who did what to whom", and one
    // person's choice of theme in that list is noise that makes the signal harder to find. Nothing
    // here touches a member, a decision or a permission.
    return next;
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
   * Both things again, not just the old password: the threat is a session somebody walked away
   * from, and the old password is written in the browser's password manager on that same machine.
   * Every other session is then signed out, because a password change is what you do when you
   * think somebody else has it.
   */
  async changePassword(
    actor: AdminPrincipal,
    input: { currentPassword: string; newPassword: string; code: string },
  ): Promise<{ auditId: string }> {
    // The new password is judged before the code is spent. The other way round, a password that
    // broke the policy burned the code with it, so every correction needed a fresh email — a
    // punishment for mistyping.
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
   * Asks for a confirmation code before changing your own credentials.
   *
   * A separate call rather than a code sent by the change itself, because the portal needs the
   * code *in hand* to fill the dialog — and because one that arrived with every opened dialog
   * would train people to ignore an email that is the only warning they get when somebody else is
   * at their desk.
   */
  async sendStepUpCode(actor: AdminPrincipal): Promise<{ expiresInSeconds: number }> {
    return this.otp.issueStepUp(actor.id, actor.email);
  }

  /**
   * Password and a code emailed a moment ago, for a change to your own credentials.
   *
   * Still two things, and deliberately not the same two as sign-in: the threat is a machine
   * somebody walked away from, where the password is already in the browser's password manager.
   * The code goes to their inbox, which that machine may well be signed into — so this is weaker
   * than it was with an authenticator in a pocket, and it is the one place where the trade bites.
   * What it still catches is the case that made it worth having: a stranger at an open session who
   * has neither the password nor the inbox.
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

    if (!credential) throw this.wrongCredentials();
    if (!(await this.passwords.verify(credential.passwordHash, password))) {
      throw this.wrongCredentials();
    }

    // Spent on success inside `consumeStepUp`, so one code authorises one change.
    if (!(await this.otp.consumeStepUp(actor.id, code))) throw this.wrongCredentials();
  }

  private wrongCredentials() {
    return ApiException.unprocessable(
      ApiErrorCode.INVALID_CREDENTIALS,
      'That password or code is not right.',
    );
  }
}

/** §5.2's `preferences` payload, with every key present. */
export interface AdminPreferencesView {
  theme: 'light' | 'dark' | 'system';
  alerts: { urgentReports: boolean; criticalGuard: boolean; assignedToMe: boolean };
}

/**
 * A stored value, with anything it does not carry filled in from the defaults.
 *
 * Shape-tolerant on purpose: the column is JSON, so a row written before a key existed is normal
 * rather than exceptional, and the portal must never be handed a switch with no state.
 */
const withDefaults = (stored: unknown): AdminPreferencesView => {
  const given = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const alerts = (given.alerts && typeof given.alerts === 'object' ? given.alerts : {}) as Record<
    string,
    unknown
  >;
  const theme = given.theme;

  return {
    theme: theme === 'light' || theme === 'dark' || theme === 'system' ? theme : 'system',
    alerts: {
      urgentReports: alerts.urgentReports !== false,
      criticalGuard: alerts.criticalGuard !== false,
      assignedToMe: alerts.assignedToMe !== false,
    },
  };
};
