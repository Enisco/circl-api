import { SendResponse, INotification } from '../interfaces';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import {
  AbstractEmailProvider,
  EmailTemplateRendererService,
  getTemplateData,
  getTemplateForEvent,
  ResendProvider,
} from '../providers';
import { NotificationStatus } from '@/common';

@Injectable()
export class EmailService extends AbstractEmailProvider {
  name: string;
  constructor(
    private readonly emailProvider: ResendProvider,
    private readonly templateRenderer: EmailTemplateRendererService,
    private logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(EmailService.name);
  }

  async send(notification: INotification): Promise<SendResponse> {
    try {
      const provider = this.canHandle(notification);

      if (!provider) {
        throw new Error(`No provider found for channel ${notification.options.channel}`);
      }
      // Get the appropriate template based on the event name
      const template = getTemplateForEvent(notification.event.eventName);

      // Get the template data based on the event
      const templateData = getTemplateData(notification.event);

      const validRecipient = this.validateInput(notification);

      if (!validRecipient) {
        throw new Error(`Receipient is not a valid email address: ${notification.recipient}`);
      }

      // Render the template with the data
      const recipient = notification.recipient;

      const renderedTemplate = this.templateRenderer.renderTemplate(template, templateData);

      this.logger.info(`Sending email to ${recipient} with template ${renderedTemplate.name}`);
      await this.emailProvider.send({
        to: recipient,
        template: renderedTemplate,
        attachments: notification.attachments,
      });

      this.logger.info(`Email sent to ${recipient} with template ${renderedTemplate.name}`);

      return {
        status: NotificationStatus.SENT,
      };
    } catch (error) {
      this.logger.error(
        `Failed to send email: ${(error as Error).message}`,
        (error as Error).stack,
      );

      return {
        status: NotificationStatus.FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
}
