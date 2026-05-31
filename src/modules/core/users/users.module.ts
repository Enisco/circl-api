import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { NotificationPrefsController, ProfileController } from './controllers';
import { NotificationPrefsService, ProfileService } from './services';

@Module({
  imports: [
    RouterModule.register([
      {
        path: 'api/v1/users',
        module: UsersModule,
        children: [ProfileController, NotificationPrefsController],
      },
    ]),
  ],
  controllers: [ProfileController, NotificationPrefsController],
  providers: [ProfileService, NotificationPrefsService],
})
export class UsersModule {}
