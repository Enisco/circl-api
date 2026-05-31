import { NotificationPriority } from '@/common';
import { registerAs } from '@nestjs/config';

export interface NotificationPriorityConfig {
  retryAttempts: number;
  retryDelay: number;
  maxConcurrent: number;
  timeout: number;
}

export const NOTIFICATION_PRIORITY_CONFIG: Record<
  NotificationPriority,
  NotificationPriorityConfig
> = {
  [NotificationPriority.LOW]: {
    retryAttempts: 1,
    retryDelay: 5000, // 5 seconds
    maxConcurrent: 10,
    timeout: 30000, // 30 seconds
  },
  [NotificationPriority.NORMAL]: {
    retryAttempts: 3,
    retryDelay: 3000, // 3 seconds
    maxConcurrent: 5,
    timeout: 20000, // 20 seconds
  },
  [NotificationPriority.HIGH]: {
    retryAttempts: 5,
    retryDelay: 2000, // 2 seconds
    maxConcurrent: 3,
    timeout: 15000, // 15 seconds
  },
  [NotificationPriority.CRITICAL]: {
    retryAttempts: 8,
    retryDelay: 1000, // 1 second
    maxConcurrent: 1,
    timeout: 10000, // 10 seconds
  },
};

export interface NotificationConfig {
  email: {
    from: string;
    supportEmail: string;
    userFrontendUrl: string;
    adminFrontendUrl: string;
  };
  aws: {
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
  queue: {
    name: string;
    attempts: number;
    backoffDelay: number;
  };
}

export default registerAs('notification', () => ({
  email: {
    from: process.env.EMAIL_FROM,
    supportEmail: process.env.SUPPORT_EMAIL,
    userFrontendUrl: process.env.USER_APP_CLIENT_URL,
    adminFrontendUrl: process.env.ADMIN_APP_CLIENT_URL,
  },
  aws: {
    region: process.env.AWS_REGION,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  queue: {
    name: process.env.NOTIFICATION_QUEUE || 'notification',
    attempts: 3,
    backoffDelay: 1000,
  },
}));
