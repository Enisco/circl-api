import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { NotificationPrefsController, ProfileController, UsernameController } from './controllers';
import { NotificationPrefsService, ProfileService } from './services';

@Module({
  imports: [
    RouterModule.register([
      {
        path: 'api/v1/users',
        module: UsersModule,
        children: [ProfileController, NotificationPrefsController, UsernameController],
      },
    ]),
  ],
  controllers: [ProfileController, NotificationPrefsController, UsernameController],
  providers: [ProfileService, NotificationPrefsService],
})
export class UsersModule {}
