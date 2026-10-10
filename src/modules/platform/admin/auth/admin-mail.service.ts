import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ResendProvider } from '@/modules/infrastructure/notification/providers';

/**
 * The four emails a staff account sends, written plainly.
 *
 * Deliberately not routed through the member template registry. These are operational notices to
 * colleagues, not product messages: three of the four exist because the response to the person
 * doing the thing has to stay uninformative, so the account's owner is told out of band instead.
 * An account lock that is only visible in a log nobody reads is not a notification.
 *
 * Sending never fails the action it describes. A password that changed and an email that did not
 * arrive is recoverable; a password change refused because the mail provider was down is not.
 */
@Injectable()
export class AdminMailService {
  private readonly logger = new Logger(AdminMailService.name);
  private readonly portalUrl: string;

  constructor(
    private readonly resend: ResendProvider,
    config: ConfigService,
  ) {
    this.portalUrl = config.getOrThrow<string>('ADMIN_CLIENT_URL').replace(/\/$/, '');
  }

  async invite(to: string, token: string, inviterName: string): Promise<void> {
    // The link and nothing else. The token is the credential, so the email carries no other hint
    // about what it opens.
    await this.send(to, 'Your Circl admin invitation', [
      `${inviterName} has invited you to the Circl admin portal.`,
      ``,
      `Set up your account here — the link works once and expires in 72 hours:`,
      `${this.portalUrl}/invite/${token}`,
      ``,
      `If you were not expecting this, tell ${inviterName} and ignore the link.`,
    ]);
  }

  async accountLocked(to: string, minutes: number): Promise<void> {
    await this.send(to, 'Your Circl admin account is temporarily locked', [
      `Too many failed sign-in attempts, so your admin account is locked for ${minutes} minutes.`,
      ``,
      `If that was you, wait and try again. If it was not, your password may be known to somebody`,
      `else — tell a super admin now so it can be reset.`,
    ]);
  }

  async passwordChanged(to: string): Promise<void> {
    await this.send(to, 'Your Circl admin password was changed', [
      `Your admin password has just been changed, and your other sessions were signed out.`,
      ``,
      `If that was not you, tell a super admin immediately.`,
    ]);
  }

  async recoveryCodeUsed(to: string, remaining: number): Promise<void> {
    await this.send(to, 'A Circl admin recovery code was used', [
      `A recovery code was just used to sign in to your admin account.`,
      `You have ${remaining} unused code${remaining === 1 ? '' : 's'} left.`,
      ``,
      `If that was not you, tell a super admin immediately.`,
    ]);
  }

  private async send(to: string, subject: string, lines: string[]): Promise<void> {
    const text = lines.join('\n');

    try {
      await this.resend.send({
        to,
        template: {
          name: 'admin-plain',
          subject,
          text,
          // Plain text wrapped for clients that insist on HTML. Nothing here is user-supplied, so
          // there is nothing to escape — and the lines are built in this file, not passed in.
          html: `<pre style="font: 14px/1.5 -apple-system, sans-serif; white-space: pre-wrap">${text}</pre>`,
        },
      });
    } catch (error) {
      this.logger.error({
        securityEvent: 'admin_mail_failed',
        subject,
        message: (error as Error).message,
      });
    }
  }
}
