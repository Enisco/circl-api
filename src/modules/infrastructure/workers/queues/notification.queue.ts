import { INotification } from '../../notification';
import { NOTIFICATION_QUEUE } from '@/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

@Injectable()
export class NotificationQueue {
  constructor(
    @InjectQueue(NOTIFICATION_QUEUE) private notificationQueue: Queue,
    private logger: PinoLogger,
  ) {
    this.logger.setContext(NotificationQueue.name);
  }

  async addNotification(notification: INotification) {
    try {
      const job = await this.notificationQueue.add('process-notification', notification, {
        priority: this.getPriorityLevel(notification.options.priority),
        attempts: notification.options.retryAttempts || 3,
        backoff: {
          type: 'exponential',
          delay: notification.options.retryDelay || 1000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      });

      this.logger.info(`Added notification to queue with job id: ${job.id}`);

      return job.id;
    } catch (error) {
      this.logger.error(`Failed to add notification to queue: ${error.message}`, error.stack);
      throw error;
    }
  }

  private getPriorityLevel(priority: string): number {
    switch (priority) {
      case 'HIGH':
        return 1;
      case 'NORMAL':
        return 2;
      case 'LOW':
        return 3;
      default:
        return 2;
    }
  }
}
