import { NotificationStatus, NotificationPriority, NotificationChannel } from '@/common';
import { Injectable } from '@nestjs/common';
import { SendResponse, INotification } from '../interfaces';
import { EmailService } from './';
import { PinoLogger } from 'nestjs-pino';
import { NOTIFICATION_PRIORITY_CONFIG } from '../config';

@Injectable()
export class NotificationService {
  constructor(
    private readonly emailService: EmailService,
    private logger: PinoLogger,
  ) {
    this.logger.setContext(NotificationService.name);
  }

  async send(notification: INotification): Promise<SendResponse> {
    try {
      this.logger.info(
        `Sending ${notification.options.priority || NotificationPriority.NORMAL} priority notification via ${notification.options.channel} channel`,
      );

      const priorityConfig =
        NOTIFICATION_PRIORITY_CONFIG[notification.options.priority || NotificationPriority.NORMAL];

      // Apply priority-based timeout
      const timeoutPromise = new Promise<SendResponse>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Notification timed out after ${priorityConfig.timeout}ms`));
        }, priorityConfig.timeout);
      });

      const sendPromise = (async () => {
        let attempts = 0;
        let lastError: Error | undefined;

        while (attempts < priorityConfig.retryAttempts) {
          try {
            switch (notification.options.channel) {
              case NotificationChannel.EMAIL:
                return await this.emailService.send(notification);

              case NotificationChannel.SMS:
                // return this.smsService.send(notification);
                break;

              case NotificationChannel.WHATSAPP:
                // return this.whatsAppService.send(notification);
                break;

              default:
                throw new Error(
                  `Unsupported notification channel: ${notification.options.channel}`,
                );
            }
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            attempts++;

            if (attempts < priorityConfig.retryAttempts) {
              await new Promise(resolve => setTimeout(resolve, priorityConfig.retryDelay));
              continue;
            }
            throw lastError;
          }
        }
        throw lastError;
      })();

      return await Promise.race([sendPromise, timeoutPromise]);
    } catch (error) {
      this.logger.error(`Failed to send notification: ${error.message}`, error.stack);

      return {
        status: NotificationStatus.FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
}
