import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import {
  NotificationPrefsController,
  ProfileController,
  SessionController,
  UserPublicController,
  UsernameController,
} from './controllers';
import {
  NotificationPrefsService,
  ProfileService,
  SessionListService,
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
          SessionController,
          UsernameController,
          UserPublicController,
        ],
      },
    ]),
  ],
  controllers: [
    ProfileController,
    NotificationPrefsController,
    SessionController,
    UsernameController,
    UserPublicController,
  ],
  providers: [
    ProfileService,
    NotificationPrefsService,
    SessionListService,
    UserActivityService,
    UserPublicService,
  ],
})
export class UsersModule {}
