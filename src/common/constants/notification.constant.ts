export const NOTIFICATION_QUEUE = 'notification-queue';

export const QUEUES = {
  NOTIFICATION_QUEUE,
} as const;

export enum NotificationChannel {
  EMAIL = 'email',
  SMS = 'sms',
  WHATSAPP = 'whatsapp',
  PUSH_NOTIFICATION = 'push_notification',
  IN_APP = 'in_app',
}

export enum NotificationPriority {
  LOW = 'low',
  NORMAL = 'normal',
  HIGH = 'high',
  CRITICAL = 'critical',
}

export enum NotificationStatus {
  PENDING = 'pending',
  SENT = 'sent',
  DELIVERED = 'delivered',
  FAILED = 'failed',
}
