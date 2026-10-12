import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserAccountStatus } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException } from '@/common';

/**
 * Why a member cannot use the app, in one shape, said the same way everywhere (§13.2).
 *
 * Three different things stop somebody getting in, and until this existed the app could not tell
 * them apart: a suspension, a deleted account and an unverified one all arrived as a bare 403 with
 * a sentence in it. The mobile client maps an unrecognised 403 on sign-in to "something went wrong
 * on our end" (`auth_bloc.dart:_mapDioError`), so a suspended member was being told the server was
 * broken, with no end date, no reason and nothing to do about it.
 *
 * So the refusal carries the answer. Three paths raise it — sign-in, refresh, and any authenticated
 * request that outlives the revocation by a few seconds — and all three raise it from here, because
 * three hand-written payloads is three chances for one of them to omit the end date.
 */

/** The states a member account can be in from the app's point of view. */
export type AccountState = 'ACTIVE' | 'PENDING' | 'SUSPENDED' | 'DELETED';

export interface SuspensionNotice {
  /** When it started. */
  startedAt: string;
  /** When it ends, or null for a suspension with no end date. */
  endsAt: string | null;
  /** Null `endsAt` is only permanent when this says so — see `User.suspendedUntil`. */
  isPermanent: boolean;
  /**
   * The member-facing reason, as the staff member who issued it wrote it. Null when they recorded
   * none: better an honest absence than a reason invented from the policy code, which is written
   * for the queue and not for the person it is about.
   */
  reason: string | null;
  /** Whether there is anything left to appeal, and where appealing happens (§13.3). */
  appeal: { isOpen: boolean; via: 'SUPPORT'; supportEmail: string };
}

export interface AccountStateView {
  state: AccountState;
  /** The one field a client should branch on to decide "show the app" or "show the wall". */
  canUseApp: boolean;
  /** The headline and sentence to show. The server owns this copy, per 0.4. */
  headline: string | null;
  message: string | null;
  suspension: SuspensionNotice | null;
  deletedAt: string | null;
  supportEmail: string;
}

/** The row every caller needs, so each one selects the same fields. */
export interface AccountStateInput {
  id: string;
  status: UserAccountStatus;
  isAnonymised?: boolean;
  suspendedUntil?: Date | null;
  /** When the account was destroyed, for the 410's `deletedAt`. Optional: not every caller selects it. */
  anonymisedAt?: Date | null;
}

/**
 * The DELETED view, with no database behind it.
 *
 * Exported as a function because the two account-deletion endpoints need the same payload and
 * cannot reach this service: `AuthModule` neither exports it nor is global, and importing that
 * module into the account module would mount the member auth routes wherever the account module
 * goes — including the admin surface, which must not serve them.
 *
 * So the copy lives once, here, beside the other two states. The alternative was a second
 * hand-written payload in the deletion service, which is how the `410` came to carry no `data` at
 * all in the first place.
 */
export const deletedAccountView = (
  anonymisedAt: Date | null | undefined,
  supportEmail: string,
): AccountStateView => ({
  state: 'DELETED',
  canUseApp: false,
  headline: 'This account has been deleted',
  message: 'Deleting an account cannot be undone. You are welcome to sign up again.',
  suspension: null,
  deletedAt: anonymisedAt?.toISOString() ?? null,
  supportEmail,
});

@Injectable()
export class AccountStateService {
  constructor(
    private readonly database: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private supportEmail(): string {
    return this.config.get<string>('SUPPORT_EMAIL') ?? 'support@circl.app';
  }

  /**
   * The refusal for a member who may not use the app, or null when they may.
   *
   * Returned rather than thrown so the caller decides the shape: the sign-in path wants it as a
   * thrown 403 and the token strategy wants the same body on a request that was already in flight.
   */
  async refusalFor(user: AccountStateInput): Promise<ApiException | null> {
    // Both refusals carry the same shape, so a client writes the handling once. The 410 used to
    // carry no `data` at all, which left the `DELETED` branch of `view` unreachable — copy nothing
    // could ever read, and a client told to render from `data.state` finding nothing there.
    if (user.isAnonymised || user.status === UserAccountStatus.SUSPENDED) {
      const view = await this.view(user);

      return user.isAnonymised
        ? ApiException.gone(
            ApiErrorCode.ACCOUNT_ALREADY_DELETED,
            view.message ?? 'This account has been deleted.',
            { data: view },
          )
        : ApiException.forbidden(
            ApiErrorCode.ACCOUNT_SUSPENDED,
            view.message ?? 'This account is suspended.',
            { data: view },
          );
    }

    return null;
  }

  /** Throws that refusal if there is one. */
  async assertUsable(user: AccountStateInput): Promise<void> {
    const refusal = await this.refusalFor(user);

    if (refusal) throw refusal;
  }

  /** The whole state, for a client that wants to render a screen rather than an error. */
  async view(user: AccountStateInput): Promise<AccountStateView> {
    const supportEmail = this.supportEmail();

    // Read rather than hardcoded null. `deletedAt` was null on every branch once, which made it a
    // field a client could read, branch on and never get an answer from.
    if (user.isAnonymised) return deletedAccountView(user.anonymisedAt, supportEmail);

    if (user.status === UserAccountStatus.PENDING) {
      return {
        state: 'PENDING',
        canUseApp: false,
        headline: 'Confirm your email address',
        message: 'We have sent you a code. Enter it to finish setting up your account.',
        suspension: null,
        deletedAt: null,
        supportEmail,
      };
    }

    if (user.status !== UserAccountStatus.SUSPENDED) {
      return {
        state: 'ACTIVE',
        canUseApp: true,
        headline: null,
        message: null,
        suspension: null,
        deletedAt: null,
        supportEmail,
      };
    }

    // The live suspension, for the reason and the start date. A member suspended before
    // `Suspension` rows existed has none (§13.1's backfill), so every field off it is optional and
    // `User.suspendedUntil` — which has always been written — is what decides the end date.
    const suspension = await this.database.suspension.findFirst({
      where: { userId: user.id, liftedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { startsAt: true, endsAt: true, note: true },
    });

    const endsAt = user.suspendedUntil ?? suspension?.endsAt ?? null;
    const isPermanent = !endsAt;

    return {
      state: 'SUSPENDED',
      canUseApp: false,
      headline: isPermanent
        ? 'Your Circl account is suspended'
        : 'Your Circl account is suspended for now',
      message: this.sentence(endsAt, suspension?.note ?? null, supportEmail),
      suspension: {
        startedAt: (suspension?.startsAt ?? new Date()).toISOString(),
        endsAt: endsAt?.toISOString() ?? null,
        isPermanent,
        reason: suspension?.note ?? null,
        appeal: { isOpen: true, via: 'SUPPORT', supportEmail },
      },
      deletedAt: null,
      supportEmail,
    };
  }

  /**
   * The same three-part sentence the suspension notification uses: what was decided, when it ends,
   * and what to do about it. One copy, so the email, the notification and the sign-in refusal
   * cannot start disagreeing about whether there is an end date.
   */
  private sentence(endsAt: Date | null, note: string | null, supportEmail: string): string {
    const when = endsAt
      ? `It ends on ${endsAt.toISOString().slice(0, 10)}.`
      : 'It does not have an end date.';

    return [note, when, `If you think this is wrong, email ${supportEmail}.`]
      .filter(Boolean)
      .join(' ');
  }
}
