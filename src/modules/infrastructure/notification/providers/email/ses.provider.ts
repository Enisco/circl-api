import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { ProviderError } from '../../errors';
import { PinoLogger } from 'nestjs-pino';
import { EmailProvider, EmailProviderOptions } from './views/interfaces';
@Injectable()
export class SesProvider implements EmailProvider {
  private readonly ses: SESClient;
  private readonly fromEmail: string;
  private readonly fromName: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SesProvider.name);
    this.ses = new SESClient({
      region: this.configService.get('AWS_REGION'),
      credentials: {
        accessKeyId: this.configService.get('AWS_ACCESS_KEY_ID'),
        secretAccessKey: this.configService.get('AWS_SECRET_ACCESS_KEY'),
      },
    });
    this.fromEmail = this.configService.get('EMAIL_FROM');
    this.fromName = this.configService.get('EMAIL_FROM_NAME');
  }

  getProviderName(): string {
    return 'AWS SES';
  }

  async send({ to, template, attachments }: EmailProviderOptions): Promise<void> {
    try {
      const rawMessage = [
        'From: ' + this.fromName + ' <' + this.fromEmail + '>',
        'To: ' + to,
        'Subject: ' + template.subject,
        'MIME-Version: 1.0',
        `Content-Type: multipart/mixed; boundary="MixedBoundary"`,
        '',
        '--MixedBoundary',
        'Content-Type: multipart/alternative; boundary="NextPart"',
        '',
        '--NextPart',
        'Content-Type: text/plain; charset=UTF-8',
        '',
        template.text,
        '',
        '--NextPart',
        'Content-Type: text/html; charset=UTF-8',
        '',
        template.html,
        '',
        '--NextPart--',
      ];

      // Add attachments if provided
      if (attachments && attachments.length > 0) {
        for (const attachment of attachments) {
          rawMessage.push(
            `--MixedBoundary`,
            `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
            'Content-Transfer-Encoding: base64',
            `Content-Disposition: attachment; filename="${attachment.filename}";`,
            '',
            attachment.content,
            '',
          );
        }
      }
      rawMessage.push(`--MixedBoundary--`);

      await this.ses.send(
        new SendRawEmailCommand({
          RawMessage: { Data: Buffer.from(rawMessage.join('\r\n')) },
        }),
      );
    } catch (error) {
      this.logger.error(error);
      throw new ProviderError(
        `Failed to send email using ${this.getProviderName()}`,
        this.getProviderName(),
        error,
      );
    }
  }
}
