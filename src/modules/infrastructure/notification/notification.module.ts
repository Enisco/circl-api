import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { NotificationService } from './services/notification.service';
import { ResendProvider, SesProvider } from './providers';
import { NotificationQueue } from '@/modules/infrastructure/workers/queues/notification.queue';
import { EmailService } from './services';
import { EmailTemplateRendererService } from './providers/email/views/email-template-renderer.service';
import { NOTIFICATION_QUEUE } from '@/common';

@Module({
  imports: [
    BullModule.registerQueue({
      name: NOTIFICATION_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
  ],
  providers: [
    NotificationService,
    SesProvider,
    ResendProvider,
    NotificationQueue,
    EmailService,
    EmailTemplateRendererService,
  ],
  exports: [NotificationService, NotificationQueue],
})
export class NotificationModule {}
