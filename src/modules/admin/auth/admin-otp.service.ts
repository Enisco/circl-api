import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from '@/infrastructure';
import { OTP_LENGTH, Util } from '@/common';
import { AdminMailService } from './admin-mail.service';

/**
 * Ten minutes.
 *
 * Longer than the five the authenticator flow allowed, because the code now has to travel: a
 * provider queue and an inbox refresh can eat a minute between the password step and the code
 * being readable, and a window that expires while somebody is waiting for the email is a window
 * that sends them back to the password screen for no reason.
 */
export const ADMIN_OTP_TTL_SECONDS = 600;
/** Wrong codes before the attempt is abandoned. 10^6 keyspace, so five is generous. */
export const ADMIN_OTP_MAX_ATTEMPTS = 5;

interface StepUpTicket {
  codeHash: string;
  attempts: number;
}

/**
 * The emailed second factor for staff.
 *
 * Replaces the authenticator app on both sign-in and setup. The trade is deliberate and it is a
 * real one: an emailed code is a weaker factor than TOTP, because it is only as strong as the
 * staff inbox it arrives in, and a compromised inbox is now sufficient rather than merely
 * necessary. What it buys is that there is nothing to enrol — no QR code, no setup window to
 * lapse, no "ask an admin to resend your invite" when it does — which is what was wanted for now.
 * `AdminTotpService` is left in place so the swap back is a change to this file and the two call
 * sites, not a rebuild.
 *
 * ## Why the code is hashed in the cache
 *
 * Six digits is not a secret worth a slow hash, and anybody who can read the cache cannot use what
 * they find there anyway: the sign-in ticket is keyed by a hash of a token they do not have. The
 * hash is here so that a cache dump is not a readable list of live codes next to the addresses
 * they belong to.
 */
@Injectable()
export class AdminOtpService {
  private readonly logger = new Logger(AdminOtpService.name);

  constructor(
    private readonly cache: CacheService,
    private readonly mail: AdminMailService,
  ) {}

  /**
   * A fresh code and its hash.
   *
   * Outside production this is the fixed `111222` — generated, not bypassed, so the ordinary
   * comparison still runs. See `dev-otp.constant.ts` for why that distinction matters.
   */
  newCode(): { code: string; codeHash: string } {
    const code = Util.generateOtp(OTP_LENGTH);

    return { code, codeHash: this.hash(code) };
  }

  hash(code: string): string {
    return Util.tokenHash(this.normalise(code));
  }

  matches(codeHash: string | null | undefined, presented: string): boolean {
    return Util.hashesMatch(codeHash, this.hash(presented));
  }

  /** Sends a sign-in code. Never throws: `AdminMailService` swallows provider failures by design. */
  async sendSignInCode(email: string, code: string): Promise<void> {
    await this.mail.signInCode(email, code, Math.round(ADMIN_OTP_TTL_SECONDS / 60));
  }

  // ─── Step-up, for changes to your own credentials ───────────────────────────

  /**
   * Emails a code for re-authenticating a change to your own account.
   *
   * Separate from the sign-in ticket because it is a different question: sign-in asks "is this
   * you", step-up asks "is this still you, at this machine, right now". Keyed by account rather
   * than by a ticket token, so asking twice replaces the code instead of leaving two live.
   */
  async issueStepUp(userId: string, email: string): Promise<{ expiresInSeconds: number }> {
    const { code, codeHash } = this.newCode();

    await this.cache.set(
      this.stepUpKey(userId),
      { codeHash, attempts: 0 } satisfies StepUpTicket,
      ADMIN_OTP_TTL_SECONDS,
    );
    await this.mail.stepUpCode(email, code, Math.round(ADMIN_OTP_TTL_SECONDS / 60));

    return { expiresInSeconds: ADMIN_OTP_TTL_SECONDS };
  }

  /**
   * Spends a step-up code.
   *
   * Spent on success, so one code authorises one change — otherwise a code read off a screen would
   * keep working for ten minutes, which is the window this is supposed to close.
   */
  async consumeStepUp(userId: string, code: string): Promise<boolean> {
    const key = this.stepUpKey(userId);
    const ticket = await this.cache.get<StepUpTicket>(key);

    if (!ticket) return false;

    if (this.matches(ticket.codeHash, code)) {
      await this.cache.delete(key);

      return true;
    }

    const attempts = ticket.attempts + 1;

    if (attempts >= ADMIN_OTP_MAX_ATTEMPTS) {
      await this.cache.delete(key);
      this.logger.warn({ securityEvent: 'admin_step_up_abandoned', userId, attempts });

      return false;
    }

    await this.cache.set(key, { ...ticket, attempts }, ADMIN_OTP_TTL_SECONDS);

    return false;
  }

  /** Upper case and unpunctuated, so a code pasted out of an email is not refused over whitespace. */
  private normalise(code: string): string {
    return code.trim().replace(/[\s-]/g, '').toUpperCase();
  }

  private stepUpKey = (userId: string) => `admin:step-up:${userId}`;
}
