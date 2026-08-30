import { Global, Module } from '@nestjs/common';
import { NotificationModule } from '@/modules/infrastructure/notification/notification.module';
import { RouterModule } from '@nestjs/core';
import { NotificationController, NotificationPreferenceController } from './controllers';
import { NotificationFeedService, NotificationPreferenceService } from './services';

/** Section 6.1. */
@Global()
@Module({
  imports: [
    // Raising a notification also pushes it, or the badge never moves (G14 15.1).
    NotificationModule,
    RouterModule.register([
      {
        path: 'api/v1',
        module: NotificationsModule,
        children: [NotificationController, NotificationPreferenceController],
      },
    ]),
  ],
  controllers: [NotificationController, NotificationPreferenceController],
  providers: [NotificationFeedService, NotificationPreferenceService],
  exports: [NotificationFeedService, NotificationPreferenceService],
})
export class NotificationsModule {}
