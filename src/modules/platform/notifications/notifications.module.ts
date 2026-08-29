import { Global, Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { NotificationController, NotificationPreferenceController } from './controllers';
import { NotificationFeedService, NotificationPreferenceService } from './services';

/** Section 6.1. */
@Global()
@Module({
  imports: [
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
