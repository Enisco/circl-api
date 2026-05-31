import { NotificationChannel } from '@/common';
import {
  ChannelProvider,
  INotification,
  SendResponse,
} from '@/modules/infrastructure/notification/interfaces';

export abstract class AbstractEmailProvider implements ChannelProvider {
  abstract name: string;
  abstract send(notification: INotification): Promise<SendResponse>;

  canHandle(notification: INotification): boolean {
    return notification.options.channel === NotificationChannel.EMAIL;
  }

  validateInput(notification: INotification): boolean {
    if (!notification.recipient) {
      return false;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    return emailRegex.test(notification.recipient);
  }
}
