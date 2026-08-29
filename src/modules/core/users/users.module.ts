import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import {
  NotificationPrefsController,
  ProfileController,
  UserPublicController,
  UsernameController,
} from './controllers';
import {
  NotificationPrefsService,
  ProfileService,
  UserActivityService,
  UserPublicService,
} from './services';

@Module({
  imports: [
    RouterModule.register([
      {
        path: 'api/v1/users',
        module: UsersModule,
        // `UserPublicController` is last because its path is `:id`, and a route parameter registered ahead of `profile` or `username` swallows them.
        children: [
          ProfileController,
          NotificationPrefsController,
          UsernameController,
          UserPublicController,
        ],
      },
    ]),
  ],
  controllers: [
    ProfileController,
    NotificationPrefsController,
    UsernameController,
    UserPublicController,
  ],
  providers: [ProfileService, NotificationPrefsService, UserActivityService, UserPublicService],
})
export class UsersModule {}
