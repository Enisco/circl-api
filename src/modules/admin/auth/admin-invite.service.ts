import { Injectable } from '@nestjs/common';
import { AdminInvite, Prisma, UserAccountStatus } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException, Util } from '@/common';
import { AdminPrincipal } from '../common/admin-principal';
import { AdminPolicyService } from '../common/admin-policy.service';
import { AuditService } from '../audit/audit.service';
import { AdminMailService } from './admin-mail.service';
import { AdminPasswordService } from './admin-password.service';

const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
/** The first send plus two resends. A fourth email is a conversation to have in person. */
const MAX_SENDS = 3;

export interface InviteView {
  id: string;
  email: string;
  role: string;
  invitedBy: { id: string; name: string; role: string } | null;
  expiresAt: string;
  state: 'LIVE' | 'EXPIRED' | 'ACCEPTED' | 'REVOKED';
  sendCount: number;
  createdAt: string;
}

/**
 * The only way a staff account comes into existence, and the only way one comes back.
 *
 * There is no self-service sign-up and no password reset by email, because either would make a
 * staff inbox sufficient to become an administrator. What there is instead: an existing
 * administrator issues a single-use link, and the account cannot sign in until a password and an
 * authenticator are both set up.
 *
 * Every invalid state — unknown, expired, used, revoked, superseded — answers identically, so the
 * endpoint cannot be used to find out which addresses have been invited.
 */
@Injectable()
export class AdminInviteService {
  constructor(
    private readonly database: PrismaService,
    private readonly policy: AdminPolicyService,
    private readonly audit: AuditService,
    private readonly mail: AdminMailService,
    private readonly passwords: AdminPasswordService,
  ) {}

  async create(
    actor: AdminPrincipal,
    input: { email: string; role: string },
  ): Promise<{ invite: InviteView; auditId: string }> {
    const email = input.email.trim().toLowerCase();

    this.policy.assertMayGrant(actor, input.role);

    const role = await this.database.role.findUnique({ where: { code: input.role } });

    if (!role?.isAdmin) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'That is not a staff role.',
        {
          details: [{ field: 'role', message: 'Unknown staff role.' }],
        },
      );
    }

    const existing = await this.database.user.findUnique({
      where: { email },
      select: { id: true, isStaff: true, adminCredential: { select: { deactivatedAt: true } } },
    });

    if (existing?.isStaff) {
      // The inviter is authenticated staff, so saying which of these it is helps them and tells an
      // outsider nothing — unlike the acceptance endpoint, which must stay uninformative.
      throw ApiException.conflict(
        ApiErrorCode.CONFLICT,
        existing.adminCredential?.deactivatedAt
          ? 'That account is deactivated. Reactivate it instead of inviting it again.'
          : 'That email already belongs to a staff account.',
      );
    }

    if (existing) {
      throw ApiException.conflict(
        ApiErrorCode.CONFLICT,
        'That email belongs to a member account. Staff need a separate address.',
      );
    }

    const live = await this.database.adminInvite.findFirst({
      where: { email, acceptedAt: null, revokedAt: null },
    });

    if (live) {
      throw ApiException.conflict(
        ApiErrorCode.CONFLICT,
        'There is already an invitation outstanding for that address. Resend it instead.',
      );
    }

    const token = this.mintToken();
    const { result, auditId } = await this.audit.mutate(
      {
        action: 'team.invite_created',
        targetType: 'STAFF',
        targetLabel: email,
        after: { email, role: input.role },
      },
      async tx =>
        tx.adminInvite.create({
          data: {
            email,
            roleId: role.id,
            tokenHash: Util.tokenHash(token),
            invitedById: actor.id,
            expiresAt: new Date(Date.now() + INVITE_TTL_MS),
          },
        }),
    );

    await this.mail.invite(email, token, this.nameOf(actor));

    return { invite: await this.view(result), auditId };
  }

  async resend(
    actor: AdminPrincipal,
    inviteId: string,
  ): Promise<{ invite: InviteView; auditId: string }> {
    const invite = await this.database.adminInvite.findUnique({
      where: { id: inviteId },
      include: { role: true },
    });

    if (!invite || invite.acceptedAt || invite.revokedAt) {
      throw this.invalid();
    }

    this.policy.assertMayGrant(actor, invite.role.code);

    if (invite.sendCount >= MAX_SENDS) {
      throw ApiException.conflict(
        ApiErrorCode.RESEND_LIMIT,
        'That invitation has been sent three times already.',
      );
    }

    const token = this.mintToken();
    const { result, auditId } = await this.audit.mutate(
      {
        action: 'team.invite_resent',
        targetType: 'STAFF',
        targetId: invite.id,
        targetLabel: invite.email,
        metadata: { sendCount: invite.sendCount + 1 },
      },
      async tx =>
        tx.adminInvite.update({
          where: { id: invite.id },
          data: {
            // A new token supersedes the old one in the same write: two live links for one account
            // is two ways in, and the second would outlive whatever made the first suspect.
            tokenHash: Util.tokenHash(token),
            expiresAt: new Date(Date.now() + INVITE_TTL_MS),
            sendCount: { increment: 1 },
            lastSentAt: new Date(),
          },
        }),
    );

    await this.mail.invite(invite.email, token, this.nameOf(actor));

    return { invite: await this.view(result), auditId };
  }

  async revoke(
    actor: AdminPrincipal,
    inviteId: string,
  ): Promise<{ invite: InviteView; auditId: string }> {
    const invite = await this.database.adminInvite.findUnique({
      where: { id: inviteId },
      include: { role: true },
    });

    if (!invite || invite.acceptedAt || invite.revokedAt) throw this.invalid();

    this.policy.assertMayGrant(actor, invite.role.code);

    const { result, auditId } = await this.audit.mutate(
      {
        action: 'team.invite_revoked',
        targetType: 'STAFF',
        targetId: invite.id,
        targetLabel: invite.email,
      },
      async tx =>
        tx.adminInvite.update({
          where: { id: invite.id },
          data: { revokedAt: new Date(), revokedById: actor.id, tokenHash: this.deadHash() },
        }),
    );

    return { invite: await this.view(result), auditId };
  }

  /** What the invite page shows before anybody types a password. */
  async inspect(
    token: string,
  ): Promise<{ email: string; role: string; inviterName: string; expiresAt: string }> {
    const invite = await this.liveByToken(token);
    const inviter = await this.database.user.findUnique({
      where: { id: invite.invitedById },
      select: { firstName: true, lastName: true },
    });

    return {
      email: invite.email,
      role: invite.role.code,
      inviterName: [inviter?.firstName, inviter?.lastName].filter(Boolean).join(' ') || 'Circl',
      expiresAt: invite.expiresAt.toISOString(),
    };
  }

  /**
   * Creates (or restores) the account and marks the invite used.
   *
   * The password is checked against the policy before anything is written, so a rejected password
   * does not consume the invitation — otherwise a typo would cost somebody their only link.
   */
  async accept(input: {
    token: string;
    firstName: string;
    lastName: string;
    password: string;
  }): Promise<{ userId: string; email: string; epoch: number }> {
    const invite = await this.liveByToken(input.token);

    await this.passwords.assertAcceptable(input.password, {
      email: invite.email,
      firstName: input.firstName,
      lastName: input.lastName,
    });

    const passwordHash = await this.passwords.hash(input.password);

    return this.database.$transaction(async tx => {
      const existing = invite.staffUserId
        ? await tx.user.findUnique({ where: { id: invite.staffUserId }, select: { id: true } })
        : await tx.user.findUnique({ where: { email: invite.email }, select: { id: true } });

      // An unbound invite whose address has since become an account is not a way into it: the only
      // invite that may restore an existing account is one issued for that account (R10).
      if (existing && !invite.staffUserId) throw this.invalid();

      // A bound invite whose account has since gone is not a licence to create a new one with that
      // address and that role — it is an invite with nothing left to restore.
      if (invite.staffUserId && !existing) throw this.invalid();

      const userId = existing?.id ?? Util.generateUuid();

      if (existing) {
        await tx.user.update({
          where: { id: userId },
          data: {
            firstName: input.firstName,
            lastName: input.lastName,
            status: UserAccountStatus.ACTIVE,
            isStaff: true,
          },
        });
      } else {
        await tx.user.create({
          data: {
            id: userId,
            firstName: input.firstName,
            lastName: input.lastName,
            email: invite.email,
            isStaff: true,
            status: UserAccountStatus.ACTIVE,
            // Staff are invited, never signed up. Null rather than EMAIL, which would put them in
            // the sign-up-method analytics they are excluded from.
            signupMethod: null,
            userRole: { create: { roleId: invite.roleId } },
          },
        });
      }

      // Nothing touches `userRole` for an existing account, which is R10: the invite restores
      // access, not the role it happened to be issued with, so a role change made while it was
      // outstanding is never undone. (There was a block here that re-applied the invite's role; it
      // sat behind the same condition that throws above, so it could never run — and would have
      // been wrong if it had.)
      const credential = await tx.adminCredential.upsert({
        where: { userId },
        update: {
          passwordHash,
          passwordUpdatedAt: new Date(),
          deactivatedAt: null,
          deactivatedById: null,
          failedAttempts: 0,
          failedMfaAttempts: 0,
          lockedUntil: null,
          // MFA starts over: the account is only usable once an authenticator is enrolled.
          totpSecretEnc: null,
          totpKeyId: null,
          totpEnabledAt: null,
          totpLastUsedStep: null,
          credentialEpoch: { increment: 1 },
        },
        create: {
          userId,
          passwordHash,
          passwordUpdatedAt: new Date(),
          invitedById: invite.invitedById,
        },
      });

      await tx.adminInvite.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date(), acceptedUserId: userId, tokenHash: this.deadHash() },
      });

      await this.audit.record(tx, {
        action: 'team.invite_accepted',
        targetType: 'STAFF',
        targetId: userId,
        actorId: userId,
        metadata: { inviteId: invite.id, role: invite.role.code },
      });

      return { userId, email: invite.email, epoch: credential.credentialEpoch };
    });
  }

  async list(state?: InviteView['state']): Promise<InviteView[]> {
    const invites = await this.database.adminInvite.findMany({
      include: { role: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 200,
    });

    const views = await Promise.all(invites.map(invite => this.view(invite)));

    return state ? views.filter(view => view.state === state) : views;
  }

  /** Invalidates every outstanding invite for an account — used by deactivation and resets. */
  async supersedeFor(userId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.adminInvite.updateMany({
      where: { staffUserId: userId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async issueFor(
    actor: AdminPrincipal,
    staffUserId: string,
    email: string,
    roleId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ invite: AdminInvite; token: string }> {
    const token = this.mintToken();
    const invite = await tx.adminInvite.create({
      data: {
        email: email.toLowerCase(),
        roleId,
        tokenHash: Util.tokenHash(token),
        invitedById: actor.id,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        staffUserId,
      },
    });

    return { invite, token };
  }

  async view(invite: AdminInvite & { role?: { code: string } }): Promise<InviteView> {
    const role =
      invite.role?.code ??
      (
        await this.database.role.findUnique({
          where: { id: invite.roleId },
          select: { code: true },
        })
      )?.code ??
      'unknown';
    const inviter = await this.database.user.findUnique({
      where: { id: invite.invitedById },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        userRole: { select: { role: { select: { code: true } } } },
      },
    });

    return {
      id: invite.id,
      email: invite.email,
      role,
      invitedBy: inviter
        ? {
            id: inviter.id,
            name: [inviter.firstName, inviter.lastName].filter(Boolean).join(' '),
            role: inviter.userRole?.role.code ?? 'unknown',
          }
        : null,
      expiresAt: invite.expiresAt.toISOString(),
      state: invite.acceptedAt
        ? 'ACCEPTED'
        : invite.revokedAt
          ? 'REVOKED'
          : invite.expiresAt <= new Date()
            ? 'EXPIRED'
            : 'LIVE',
      sendCount: invite.sendCount,
      createdAt: invite.createdAt.toISOString(),
    };
  }

  private async liveByToken(token: string): Promise<AdminInvite & { role: { code: string } }> {
    const invite = await this.database.adminInvite.findUnique({
      where: { tokenHash: Util.tokenHash(token) },
      include: { role: true },
    });

    if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt <= new Date()) {
      throw this.invalid();
    }

    return invite;
  }

  private mintToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /**
   * A hash of random bytes, to retire a used or revoked token.
   *
   * The column is unique and not nullable, and nulling it would also lose the evidence that the
   * row ever had one. A hash nothing can produce is dead without being absent.
   */
  private deadHash(): string {
    return Util.tokenHash(randomBytes(32).toString('base64url'));
  }

  private nameOf(actor: AdminPrincipal): string {
    return [actor.firstName, actor.lastName].filter(Boolean).join(' ') || 'A Circl administrator';
  }

  private invalid() {
    return ApiException.notFound(
      'That invitation is not valid any more.',
      ApiErrorCode.INVITE_INVALID,
    );
  }
}
