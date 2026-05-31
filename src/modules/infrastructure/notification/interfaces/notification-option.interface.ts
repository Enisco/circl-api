import { NotificationChannel, NotificationPriority } from '@/common';

export interface INotificationOptions {
  channel: NotificationChannel;
  priority?: NotificationPriority;
  retryAttempts?: number;
  retryDelay?: number;
  templateId?: string;
  data?: Record<string, any>;
}
