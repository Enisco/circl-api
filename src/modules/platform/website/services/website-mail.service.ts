import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ResendProvider } from '@/modules/infrastructure/notification/providers';

/**
 * The notification a website submission sends to the team.
 *
 * Deliberately not routed through the member template registry, for the same reason
 * `AdminMailService` is not: these are operational notices to colleagues, not product messages to
 * a member, and there is no member to address them to. Until the portal grows a queue, this email
 * **is** the inbox — so it carries everything needed to act without opening anything else.
 *
 * Sending never fails the submission. A visitor who was told "we got it" and then saw a 500
 * because a mail provider was down would send it again; the row is already saved, and the log line
 * says the email did not go.
 */
@Injectable()
export class WebsiteMailService {
  private readonly logger = new Logger(WebsiteMailService.name);
  private readonly teamInbox: string;

  constructor(
    private readonly resend: ResendProvider,
    config: ConfigService,
  ) {
    // One address for all three forms. `WEBSITE_TEAM_EMAIL` splits them off when the team wants
    // deletion requests going somewhere narrower than general enquiries — a data-requests inbox
    // with fewer people in it — without this code having to know which inbox is which.
    this.teamInbox =
      config.get<string>('WEBSITE_TEAM_EMAIL') ?? config.getOrThrow<string>('SUPPORT_EMAIL');
  }

  async contactMessage(input: {
    id: string;
    name: string;
    email: string;
    topic: string;
    message: string;
  }): Promise<void> {
    await this.send({
      id: input.id,
      kind: 'CONTACT_MESSAGE',
      subject: `Website message (${input.topic}) from ${input.name}`,
      replyTo: input.email,
      lines: [
        `${input.name} <${input.email}> sent this through the website.`,
        ``,
        `Topic: ${input.topic}`,
        ``,
        input.message,
        ``,
        `— Reply to this email and it goes straight to them. Submission ${input.id}.`,
      ],
    });
  }

  async featureSuggestion(input: {
    id: string;
    title: string;
    area: string;
    details: string;
    email?: string | null;
  }): Promise<void> {
    await this.send({
      id: input.id,
      kind: 'FEATURE_SUGGESTION',
      subject: `Website suggestion (${input.area}): ${input.title}`,
      // Only when they gave one. A `Reply-To` of nothing is a reply that bounces.
      replyTo: input.email ?? undefined,
      lines: [
        input.email
          ? `Suggested from the website by <${input.email}>, who would like to hear back.`
          : `Suggested from the website. No address given, so there is nobody to reply to.`,
        ``,
        `Area: ${input.area}`,
        ``,
        input.details,
        ``,
        `— Submission ${input.id}.`,
      ],
    });
  }

  /**
   * The one a person has to act on.
   *
   * No `Reply-To`. Everything else here invites a reply to the address that was typed in, and this
   * form is the one where that address may not be the person's own — so the email says to use the
   * address on the account, which is the rule the whole flow rests on.
   */
  async deletionRequest(input: {
    id: string;
    name: string;
    email: string;
    reason: string;
    details?: string | null;
    /** Whether a live account uses that address. Looked up already, so nobody repeats it by hand. */
    matched: boolean;
  }): Promise<void> {
    await this.send({
      id: input.id,
      kind: 'DELETION_REQUEST',
      subject: `Account deletion requested (${input.reason})`,
      lines: [
        `Somebody asked, through the website, to have a Circl account deleted.`,
        ``,
        `Name given:    ${input.name}`,
        `Email given:   ${input.email}`,
        `Reason:        ${input.reason}`,
        `Account found: ${input.matched ? 'yes' : 'no'}`,
        ...(input.details ? [``, `What they said:`, input.details] : []),
        ``,
        ...(input.matched
          ? [
              `What to do:`,
              `  1. Email THAT address — never a different one — and ask them to confirm it is them.`,
              `  2. Once they have, run the deletion from the portal: Members → the member →`,
              `     Anonymise. It asks you to type their username, which is the confirmation.`,
              ``,
              `Anyone can type anyone's address into a web form, so nothing is deleted until the`,
              `person has shown they can read the inbox on the account.`,
            ]
          : [
              `No live account uses that address, so there is nothing to delete and nothing was`,
              `sent to them — the website has already told them to expect an email, so somebody`,
              `should decide whether to reply.`,
              ``,
              `Worth checking before concluding they have no account: a member who signed in with`,
              `Apple and hid their address has an @privaterelay.appleid.com address on the`,
              `account, which they will not remember. Those have to be deleted from inside the app.`,
            ]),
        ``,
        `— Submission ${input.id}.`,
      ],
    });
  }

  private async send(input: {
    /** The submission this is about, so a failure is traceable without logging what it said. */
    id: string;
    kind: string;
    subject: string;
    lines: string[];
    replyTo?: string;
  }): Promise<void> {
    const text = input.lines.join('\n');

    try {
      await this.resend.send({
        to: this.teamInbox,
        replyTo: input.replyTo,
        template: {
          name: 'website-plain',
          subject: input.subject,
          text,
          // **Escaped**, unlike `AdminMailService`'s equivalent, and that difference is the whole
          // point: every line here contains something a stranger typed into a public form. An
          // unescaped `<script>` in a message body is a payload delivered to whoever opens it.
          html: `<pre style="font: 14px/1.5 -apple-system, sans-serif; white-space: pre-wrap">${escapeHtml(text)}</pre>`,
        },
      });
    } catch (error) {
      // The id and the type, never the subject — which carries the name the visitor typed, and on
      // a suggestion their title as well. A log line that holds either is a second copy of
      // somebody's personal data in a place nobody is guarding (NFR-5), and the id is enough:
      // whoever reads this can look the row up if they are entitled to.
      this.logger.error({
        event: 'website_mail_failed',
        id: input.id,
        kind: input.kind,
        message: (error as Error).message,
      });
    }
  }
}

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, char => ENTITIES[char]);
