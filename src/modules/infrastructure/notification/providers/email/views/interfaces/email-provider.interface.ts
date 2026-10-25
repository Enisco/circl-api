import { EmailAttachment, EmailTemplate } from './email-template.interface';

export interface EmailProviderOptions {
  to: string;
  template: EmailTemplate;
  attachments?: EmailAttachment[];
  /**
   * Where a reply should go, when that is not the sender.
   *
   * For a notice forwarding something a stranger wrote — a website enquiry landing in the team's
   * inbox — the useful reply address is theirs, not `EMAIL_FROM`. Omitted everywhere else, which
   * leaves the provider's own default.
   */
  replyTo?: string;
}

export interface EmailProvider {
  send(options: EmailProviderOptions): Promise<void>;
  getProviderName(): string;
}
