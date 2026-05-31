import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { NOTIFICATION_QUEUE, NotificationStatus } from '@/common';
import { INotification, NotificationService } from '@/modules/infrastructure/notification';

@Injectable()
@Processor(NOTIFICATION_QUEUE)
export class NotificationProcessor extends WorkerHost {
  constructor(
    private readonly notificationService: NotificationService,
    private logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(NotificationProcessor.name);
  }

  async process(job: Job<INotification>): Promise<void> {
    try {
      this.logger.info(
        `Processing notification job ${job.id} for channel ${job.data.options.channel}`,
      );
      const result = await this.notificationService.send(job.data);

      if (result.status === NotificationStatus.FAILED) {
        throw result.error;
      }
      this.logger.info(`Successfully processed notification job ${job.id}`);
    } catch (error) {
      this.logger.error(
        `Failed to process notification job ${job.id}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}
