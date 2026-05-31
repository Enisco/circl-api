import {
  AccountVerifiedEvent,
  AccountCreatedEvent,
  AccountBlockedEvent,
  UserLoginOtpEvent,
  UserForgotPasswordEvent,
} from '@/modules/infrastructure/events';
import { EmailAttachment } from '../providers';
import { NotificationStatus } from '@/common';
import { INotificationOptions } from './notification-option.interface';

export type NotificationEvent =
  | AccountCreatedEvent
  | AccountVerifiedEvent
  | AccountBlockedEvent
  | UserLoginOtpEvent
  | UserForgotPasswordEvent;

export interface INotification {
  id?: string;
  recipient: string;
  subject?: string;
  content?: string;
  options: INotificationOptions;
  event: NotificationEvent;
  status?: NotificationStatus;
  sentAt?: Date;
  deliveredAt?: Date;
  failedAt?: Date;
  errorMessage?: string;
  retryCount?: number;
  maxRetries?: number;
  attachments?: EmailAttachment[];
}
