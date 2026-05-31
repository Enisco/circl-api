import { Injectable } from '@nestjs/common';
import { Resend } from 'resend';
import { EmailProvider, EmailProviderOptions } from './views';
import { PinoLogger } from 'nestjs-pino';
import { ConfigService } from '@nestjs/config';
import { ProviderError } from '../../errors';

@Injectable()
export class ResendProvider implements EmailProvider {
  private readonly resend: Resend;
  private readonly fromEmail: string;
  private readonly fromName: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ResendProvider.name);
    this.resend = new Resend(this.configService.get('RESEND_API_KEY'));
    this.fromEmail = this.configService.get('EMAIL_FROM');
    this.fromName = this.configService.get('EMAIL_FROM_NAME');
  }

  getProviderName(): string {
    return 'RESEND';
  }

  async send({ to, template, attachments }: EmailProviderOptions): Promise<void> {
    try {
      await this.resend.emails.send({
        from: `${this.fromName} <${this.fromEmail}>`,
        to,
        subject: template.subject,
        html: template.html,
        text: template.text,
        attachments: attachments?.map(attachment => ({
          filename: attachment.filename,
          content: attachment.content,
          contentType: attachment.contentType,
        })),
      });
    } catch (error) {
      this.logger.error(error);
      throw new ProviderError(
        `Failed to send email using ${this.getProviderName()}`,
        this.getProviderName(),
        error as Error,
      );
    }
  }
}
