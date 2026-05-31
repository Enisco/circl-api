import { NotificationStatus } from '@/common';
import { INotification } from './notification.interface';

export interface SendResponse {
  id?: string;
  status: NotificationStatus;
  providerReference?: string;
  details?: Record<string, any>;
  error?: Error;
}

export interface ChannelProvider {
  name: string;
  send(notification: INotification): Promise<SendResponse>;
  getStatus?(id: string): Promise<NotificationStatus>;
  validateInput(notification: INotification): boolean | Promise<boolean>;
  canHandle?(notification: INotification): boolean;
}
