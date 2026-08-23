import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { FcmService } from './providers/push/fcm.service';
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
    FcmService,
  ],
  // FcmService is exported because messaging pushes directly (5.6): the socket
  // decides per recipient whether a message needs a push, which is a decision
  // only that path can make.
  exports: [NotificationService, NotificationQueue, FcmService],
})
export class NotificationModule {}
