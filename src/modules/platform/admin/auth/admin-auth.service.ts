import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AdminSessionRevokeReason, UserAccountStatus } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { CacheService, PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException, Util } from '@/common';
import { AuditService } from '../audit/audit.service';
import { adminContext } from '../common/admin-context';
import { AdminMailService } from './admin-mail.service';
import { AdminPasswordService } from './admin-password.service';
import { AdminRecoveryCodeService } from './admin-recovery-code.service';
import { AdminTotpService } from './admin-totp.service';
import {
  ADMIN_ACCESS_TTL_SECONDS,
  ADMIN_REFRESH_GRACE_MS,
  AdminSessionService,
} from './admin-session.service';
import {
  ADMIN_TOKEN_AUDIENCE,
  ADMIN_TOKEN_ISSUER,
  ADMIN_TOKEN_TYPE,
} from './admin-jwt.strategy';

/** How long the half-finished login lives. Long enough to find a phone, short enough to be no use later. */
const MFA_TOKEN_TTL_SECONDS = 300;
const MFA_SETUP_TTL_SECONDS = 900;
const MFA_MAX_ATTEMPTS = 5;
/** Consecutive failures before the account locks. */
const LOCK_THRESHOLD = 5;
const LOCK_BASE_MINUTES = 15;
const LOCK_MAX_MINUTES = 24 * 60;

export interface TokenPairView {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  sessionId: string;
}

export type LoginResult =
  | { mfaRequired: true; mfaToken: string; mfaTokenExpiresIn: number }
  | { mfaEnrollmentRequired: true; mfaSetupToken: string; otpauthUri: string; secret: string };

interface MfaTicket {
  userId: string;
  email: string;
  attempts: number;
  ipHash: string;
  uaHash: string;
}

interface SetupTicket {
  userId: string;
  secretEnc: string;
  keyId: string;
  attempts: number;
  /** The credential epoch this was issued under; a reset moves the epoch and strands the ticket. */
  epoch: number;
}

/**
 * Staff sign-in: password, then a second factor, then a session.
 *
 * Everything here is shaped by one rule — a failure must not say which failure it was. An unknown
 * email, a non-staff account, a deactivated account, a wrong password, a locked account and an
 * unenrolled authenticator all produce the same body in about the same time. Whoever is trying
 * addresses learns nothing about which ones are worth pursuing, and the account's owner is told by
 * email, which is a channel an attacker does not control.
 */
@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);

  constructor(
    private readonly database: PrismaService,
    private readonly cache: CacheService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly passwords: AdminPasswordService,
    private readonly totp: AdminTotpService,
    private readonly recoveryCodes: AdminRecoveryCodeService,
    private readonly sessions: AdminSessionService,
    private readonly audit: AuditService,
    private readonly mail: AdminMailService,
  ) {}

  // ─── Step one: the password ─────────────────────────────────────────────────

  async login(email: string, password: string): Promise<LoginResult> {
    const normalised = email.trim().toLowerCase();
    const user = await this.database.user.findUnique({
      where: { email: normalised },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        isStaff: true,
        status: true,
        adminCredential: true,
        userRole: { select: { role: { select: { code: true, isAdmin: true } } } },
      },
    });

    const credential = user?.adminCredential;
    const role = user?.userRole?.role;
    const eligible =
      user &&
      user.isStaff &&
      user.status === UserAccountStatus.ACTIVE &&
      credential &&
      credential.deactivatedAt === null &&
      role?.isAdmin;

    if (!eligible) {
      // Same work as a real verification, so the response time does not answer the question the
      // response body refuses to.
      await this.passwords.burnTime();
      await this.audit.note({
        action: 'auth.login_failed',
        targetType: 'STAFF',
        targetId: user?.id ?? null,
        actorId: user?.id ?? null,
        metadata: { emailHash: this.hashEmail(normalised), reason: 'not_eligible' },
      });

      throw this.genericFailure();
    }

    if (credential.lockedUntil && credential.lockedUntil > new Date()) {
      await this.passwords.burnTime();
      await this.audit.note({
        action: 'auth.login_failed',
        targetType: 'STAFF',
        targetId: user.id,
        actorId: user.id,
        metadata: { emailHash: this.hashEmail(normalised), reason: 'locked' },
      });

      throw this.genericFailure();
    }

    if (!(await this.passwords.verify(credential.passwordHash, password))) {
      await this.registerFailure(user.id, 'password', normalised);

      throw this.genericFailure();
    }

    // Parameters may have been raised since this hash was made; a correct password is the only
    // moment the plaintext is available to rehash with.
    if (this.passwords.needsRehash(credential.passwordHash)) {
      await this.database.adminCredential.update({
        where: { userId: user.id },
        data: { passwordHash: await this.passwords.hash(password), passwordUpdatedAt: new Date() },
      });
    }

    await this.database.adminCredential.update({
      where: { userId: user.id },
      data: { failedAttempts: 0, failedMfaAttempts: 0, lockedUntil: null },
    });

    await this.audit.note({
      action: 'auth.login_password_ok',
      targetType: 'STAFF',
      targetId: user.id,
      actorId: user.id,
    });

    // Enrolled: hand back a ticket for the second factor. Not enrolled — an invite accepted but
    // the setup window missed, or an MFA reset — hand back the enrolment path instead, so the
    // account is never reachable with a password alone.
    if (!credential.totpEnabledAt || !credential.totpSecretEnc) {
      return this.beginEnrolment(user.id, user.email, credential.credentialEpoch);
    }

    return {
      mfaRequired: true,
      mfaToken: await this.issueMfaTicket(user.id, normalised),
      mfaTokenExpiresIn: MFA_TOKEN_TTL_SECONDS,
    };
  }

  // ─── Step two: the second factor ────────────────────────────────────────────

  async verifyMfa(mfaToken: string, code: string): Promise<TokenPairView> {
    const key = this.mfaKey(mfaToken);
    const ticket = await this.cache.get<MfaTicket>(key);

    if (!ticket) throw this.mfaTokenInvalid();

    // Bound to the IP and client that passed the password step: a ticket intercepted in transit is
    // of no use from anywhere else.
    if (ticket.ipHash !== this.contextHash('ip') || ticket.uaHash !== this.contextHash('ua')) {
      await this.cache.delete(key);

      throw this.mfaTokenInvalid();
    }

    const credential = await this.database.adminCredential.findUnique({
      where: { userId: ticket.userId },
    });

    if (!credential?.totpSecretEnc) throw this.mfaTokenInvalid();

    const secret = this.totp.decrypt(credential.totpSecretEnc);
    const totpResult = await this.totp.check(secret, code, credential.totpLastUsedStep);
    let method: 'totp' | 'recovery_code' = 'totp';
    let accepted = totpResult.valid;

    if (!accepted) {
      accepted = await this.recoveryCodes.consume(ticket.userId, code);
      method = 'recovery_code';
    }

    if (!accepted) {
      const attempts = ticket.attempts + 1;

      if (attempts >= MFA_MAX_ATTEMPTS) {
        await this.cache.delete(key);
        await this.registerFailure(ticket.userId, 'mfa', ticket.email);

        throw this.mfaTokenInvalid();
      }

      await this.cache.set(key, { ...ticket, attempts }, MFA_TOKEN_TTL_SECONDS);
      await this.registerFailure(ticket.userId, 'mfa', ticket.email);

      throw this.genericFailure();
    }

    await this.cache.delete(key);

    const data: Record<string, unknown> = {
      failedAttempts: 0,
      failedMfaAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      lastLoginIp: adminContext.current()?.clientIp ?? null,
      lastActiveAt: new Date(),
    };

    // Recorded only for a code that came from the authenticator: a recovery code has no step, and
    // writing one would push the replay bound past codes the app is about to produce.
    if (method === 'totp' && totpResult.step !== null) {
      data.totpLastUsedStep = BigInt(totpResult.step);
    }

    await this.database.adminCredential.update({ where: { userId: ticket.userId }, data });

    const pair = await this.openSession(ticket.userId);

    await this.audit.note({
      action: 'auth.login_success',
      targetType: 'STAFF',
      targetId: ticket.userId,
      actorId: ticket.userId,
      metadata: { method },
    });

    if (method === 'recovery_code') {
      const remaining = await this.recoveryCodes.remainingCount(ticket.userId);

      this.logger.warn({
        securityEvent: 'admin_recovery_code_used',
        userId: ticket.userId,
        remaining,
      });
      await this.audit.note({
        action: 'auth.recovery_code_used',
        targetType: 'STAFF',
        targetId: ticket.userId,
        actorId: ticket.userId,
        metadata: { remaining },
      });
      await this.mail.recoveryCodeUsed(ticket.email, remaining);
    }

    return pair;
  }

  // ─── Enrolment ──────────────────────────────────────────────────────────────

  async beginEnrolment(userId: string, email: string, epoch: number): Promise<LoginResult> {
    const secret = this.totp.newSecret();
    const encrypted = this.totp.encrypt(secret);
    const token = randomBytes(32).toString('base64url');

    await this.cache.set(
      this.setupKey(token),
      {
        userId,
        secretEnc: encrypted.ciphertext,
        keyId: encrypted.keyId,
        attempts: 0,
        epoch,
      } satisfies SetupTicket,
      MFA_SETUP_TTL_SECONDS,
    );

    return {
      mfaEnrollmentRequired: true,
      mfaSetupToken: token,
      otpauthUri: this.totp.uri(secret, email),
      secret,
    };
  }

  async enrol(
    setupToken: string,
    code: string,
  ): Promise<{ recoveryCodes: string[]; tokens: TokenPairView }> {
    const key = this.setupKey(setupToken);
    const ticket = await this.cache.get<SetupTicket>(key);

    if (!ticket) throw this.mfaTokenInvalid();

    const credential = await this.database.adminCredential.findUnique({
      where: { userId: ticket.userId },
    });

    if (!credential) throw this.mfaTokenInvalid();

    // A reset, deactivation or role change since the ticket was issued moves the epoch. Without
    // this, a setup token obtained before a "reset everything" for a suspected compromise would
    // still activate the account afterwards (S7.5a).
    if (credential.credentialEpoch !== ticket.epoch) {
      await this.cache.delete(key);

      throw this.mfaTokenInvalid();
    }

    if (credential.totpEnabledAt) {
      throw ApiException.conflict(
        ApiErrorCode.MFA_ALREADY_ENROLLED,
        'That account already has an authenticator set up.',
      );
    }

    const secret = this.totp.decrypt(ticket.secretEnc);
    const result = await this.totp.check(secret, code, null);

    if (!result.valid) {
      const attempts = ticket.attempts + 1;

      if (attempts >= MFA_MAX_ATTEMPTS) {
        await this.cache.delete(key);

        throw this.mfaTokenInvalid();
      }

      await this.cache.set(key, { ...ticket, attempts }, MFA_SETUP_TTL_SECONDS);

      throw this.genericFailure();
    }

    await this.cache.delete(key);

    const codes = await this.database.$transaction(async tx => {
      await tx.adminCredential.update({
        where: { userId: ticket.userId },
        data: {
          totpSecretEnc: ticket.secretEnc,
          totpKeyId: ticket.keyId,
          totpEnabledAt: new Date(),
          totpLastUsedStep: result.step !== null ? BigInt(result.step) : null,
          failedMfaAttempts: 0,
        },
      });

      const issued = await this.recoveryCodes.issue(ticket.userId, tx);

      await this.audit.record(tx, {
        action: 'auth.mfa_enrolled',
        targetType: 'STAFF',
        targetId: ticket.userId,
        actorId: ticket.userId,
      });

      return issued;
    });

    return { recoveryCodes: codes, tokens: await this.openSession(ticket.userId) };
  }

  // ─── Refresh ────────────────────────────────────────────────────────────────

  /**
   * Rotates the pair, with a grace window and reuse detection.
   *
   * The grace window exists because the portal runs more than one server process: two of them can
   * present the same refresh token within milliseconds, and without it the second would look
   * exactly like a stolen token being replayed. Outside the window it *is* that, and the session
   * goes.
   */
  async refresh(refreshToken: string): Promise<TokenPairView> {
    const sessionId = this.sessions.sessionIdFrom(refreshToken);

    if (!sessionId) throw this.sessionRevoked();

    const grace = await this.sessions.recallGrace<TokenPairView>(refreshToken);

    if (grace) return grace;

    const rotated = await this.sessions.withRefreshLock(sessionId, async () => {
      // Checked again inside the lock: the holder of the lock may have just answered this token.
      const replayed = await this.sessions.recallGrace<TokenPairView>(refreshToken);

      if (replayed) return replayed;

      const session = await this.database.adminSession.findUnique({ where: { id: sessionId } });

      if (!session || session.revokedAt) throw this.sessionRevoked();

      const presented = Util.tokenHash(refreshToken);
      const matchesCurrent = Util.hashesMatch(presented, session.refreshTokenHash);
      const matchesPrevious = Util.hashesMatch(presented, session.previousRefreshTokenHash);

      if (!matchesCurrent) {
        const withinGrace =
          matchesPrevious &&
          session.rotatedAt !== null &&
          Date.now() - session.rotatedAt.getTime() <= ADMIN_REFRESH_GRACE_MS;

        // Inside the window the grace cache would have answered already; reaching here means it
        // expired early, and re-rotating would strand whichever process holds the new token.
        if (withinGrace) throw this.sessionRevoked();

        await this.handleReuse(session.id, session.userId);

        throw this.sessionRevoked();
      }

      if (this.sessions.expiryReason({
        id: session.id,
        userId: session.userId,
        revoked: false,
        absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
        lastUsedAt: session.lastUsedAt.toISOString(),
      })) {
        await this.sessions.revoke(session.id, AdminSessionRevokeReason.EXPIRED);

        throw this.sessionRevoked();
      }

      const next = this.sessions.mintRefreshToken(session.id);

      await this.database.adminSession.update({
        where: { id: session.id },
        data: {
          refreshTokenHash: Util.tokenHash(next),
          previousRefreshTokenHash: session.refreshTokenHash,
          rotatedAt: new Date(),
          lastUsedAt: new Date(),
        },
      });

      const pair = await this.pairFor(session.id, session.userId, next);

      await this.sessions.rememberGrace(refreshToken, pair);

      return pair;
    });

    // The lock was held by another request doing the same rotation. Its answer is in the grace
    // cache a moment later; one short wait is better than failing a refresh that did succeed.
    if (!rotated) {
      const settled = await this.sessions.recallGrace<TokenPairView>(refreshToken);

      if (settled) return settled;

      throw ApiException.conflict(
        ApiErrorCode.IDEMPOTENT_REQUEST_IN_PROGRESS,
        'That session is already being refreshed.',
      );
    }

    return rotated;
  }

  async logout(sessionId: string, actorId: string): Promise<void> {
    await this.sessions.revoke(sessionId, AdminSessionRevokeReason.LOGOUT, actorId);
    await this.audit.note({
      action: 'auth.logout',
      targetType: 'STAFF',
      targetId: actorId,
      actorId,
    });
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  async openSession(userId: string): Promise<TokenPairView> {
    const context = adminContext.current();
    const { session, refreshToken } = await this.sessions.create({
      userId,
      ip: context?.clientIp ?? null,
      userAgent: context?.userAgent ?? null,
    });

    return this.pairFor(session.id, userId, refreshToken);
  }

  private async pairFor(
    sessionId: string,
    userId: string,
    refreshToken: string,
  ): Promise<TokenPairView> {
    const session = await this.database.adminSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: {
        absoluteExpiresAt: true,
        user: { select: { userRole: { select: { role: { select: { code: true } } } } } },
      },
    });

    const accessToken = await this.jwt.signAsync(
      {
        sub: userId,
        sid: sessionId,
        typ: ADMIN_TOKEN_TYPE,
        role: session.user.userRole?.role.code ?? null,
      },
      {
        secret: this.config.getOrThrow<string>('ADMIN_JWT_ACCESS_SECRET'),
        expiresIn: ADMIN_ACCESS_TTL_SECONDS,
        issuer: ADMIN_TOKEN_ISSUER,
        audience: ADMIN_TOKEN_AUDIENCE,
        algorithm: 'HS256',
      },
    );

    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAt: new Date(Date.now() + ADMIN_ACCESS_TTL_SECONDS * 1000).toISOString(),
      // The earlier of the two bounds, so the portal knows when it will actually have to sign in
      // again rather than when the absolute limit happens to fall.
      refreshTokenExpiresAt: new Date(
        Math.min(session.absoluteExpiresAt.getTime(), Date.now() + 30 * 60 * 1000),
      ).toISOString(),
      sessionId,
    };
  }

  private async handleReuse(sessionId: string, userId: string): Promise<void> {
    this.logger.warn({ securityEvent: 'admin_refresh_reuse', sessionId, userId });

    await this.sessions.revoke(sessionId, AdminSessionRevokeReason.REFRESH_REUSE);
    await this.audit.note({
      action: 'auth.refresh_reuse',
      targetType: 'STAFF',
      targetId: userId,
      actorId: userId,
      metadata: { sessionId },
    });
  }

  /**
   * Counts a failure and locks the account when they mount up, each lock twice the last.
   *
   * The duration doubling is what makes guessing uneconomic without ever locking somebody out for
   * good: a legitimate owner waits fifteen minutes once, and a script waits a day by its tenth try.
   */
  private async registerFailure(
    userId: string,
    kind: 'password' | 'mfa',
    email?: string,
  ): Promise<void> {
    const credential = await this.database.adminCredential.update({
      where: { userId },
      data:
        kind === 'password'
          ? { failedAttempts: { increment: 1 } }
          : { failedMfaAttempts: { increment: 1 } },
    });

    const failures = kind === 'password' ? credential.failedAttempts : credential.failedMfaAttempts;
    const threshold = kind === 'password' ? LOCK_THRESHOLD : LOCK_THRESHOLD * 2;

    await this.audit.note({
      action: 'auth.login_failed',
      targetType: 'STAFF',
      targetId: userId,
      actorId: userId,
      // The hash on every failure, not only the ones with no account behind them: an investigator
      // asking "was anybody trying this address" should get one answer from one query.
      metadata: { reason: kind, ...(email ? { emailHash: this.hashEmail(email) } : {}) },
    });

    if (failures < threshold) return;

    const lockCount = credential.lockCount + 1;
    const minutes = Math.min(LOCK_BASE_MINUTES * 2 ** (lockCount - 1), LOCK_MAX_MINUTES);

    await this.database.adminCredential.update({
      where: { userId },
      data: {
        lockCount,
        lockedUntil: new Date(Date.now() + minutes * 60 * 1000),
        failedAttempts: 0,
        failedMfaAttempts: 0,
      },
    });

    this.logger.warn({ securityEvent: 'admin_account_locked', userId, minutes, lockCount });

    // Out of band, because the response cannot say it. Told to the address that owns the account,
    // which is a channel whoever is guessing does not control.
    if (email) await this.mail.accountLocked(email, minutes);
    await this.audit.note({
      action: 'auth.account_locked',
      targetType: 'STAFF',
      targetId: userId,
      // No actor: nobody authenticated, which is the whole point of recording it.
      actorId: null,
      metadata: { minutes, lockCount, reason: kind },
    });
  }

  private async issueMfaTicket(userId: string, email: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');

    await this.cache.set(
      this.mfaKey(token),
      {
        userId,
        email,
        attempts: 0,
        ipHash: this.contextHash('ip'),
        uaHash: this.contextHash('ua'),
      } satisfies MfaTicket,
      MFA_TOKEN_TTL_SECONDS,
    );

    return token;
  }

  private mfaKey = (token: string) => `admin:mfa:${Util.tokenHash(token)}`;
  private setupKey = (token: string) => `admin:mfa-setup:${Util.tokenHash(token)}`;

  private contextHash(part: 'ip' | 'ua'): string {
    const context = adminContext.current();
    const value = part === 'ip' ? context?.clientIp : context?.userAgent;

    return createHash('sha256').update(value ?? 'unknown').digest('hex');
  }

  /** Never stored in the clear: an audit trail of failed logins should not be a list of addresses. */
  private hashEmail(email: string): string {
    return createHash('sha256').update(email).digest('hex').slice(0, 32);
  }

  private genericFailure() {
    return ApiException.unauthorized(
      'Those details are not right.',
      ApiErrorCode.INVALID_CREDENTIALS,
    );
  }

  private mfaTokenInvalid() {
    return ApiException.unauthorized(
      'That sign-in attempt has expired. Start again.',
      ApiErrorCode.MFA_TOKEN_INVALID,
    );
  }

  private sessionRevoked() {
    return ApiException.unauthorized(
      'That admin session is no longer valid.',
      ApiErrorCode.SESSION_REVOKED,
    );
  }
}
