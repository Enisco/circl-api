import { Global, Module } from '@nestjs/common';
import { NotificationModule } from '@/modules/infrastructure/notification/notification.module';
import { RouterModule } from '@nestjs/core';
import { NotificationController, NotificationPreferenceController } from './controllers';
import { NotificationFeedService, NotificationPreferenceService } from './services';

/**
 * Section 6.1's services — no controllers, for the same reason as `MessagingCoreModule`.
 *
 * The admin surface needs `NotificationFeedService` to tell a member their content was removed. It
 * does not need the member's own notification feed and preference routes, which were mounted
 * alongside it and answered `500` on that host.
 */
@Global()
@Module({
  // Raising a notification also pushes it, or the badge never moves (G14 15.1).
  imports: [NotificationModule],
  providers: [NotificationFeedService, NotificationPreferenceService],
  exports: [NotificationFeedService, NotificationPreferenceService],
})
export class NotificationsCoreModule {}

/** Section 6.1's member routes. */
@Module({
  imports: [
    NotificationsCoreModule,
    RouterModule.register([
      {
        path: 'api/v1',
        module: NotificationsModule,
        children: [NotificationController, NotificationPreferenceController],
      },
    ]),
  ],
  controllers: [NotificationController, NotificationPreferenceController],
  exports: [NotificationsCoreModule],
})
export class NotificationsModule {}
