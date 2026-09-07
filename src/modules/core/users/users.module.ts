import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import {
  NotificationPrefsController,
  ProfileController,
  SessionController,
  UserDirectoryController,
  UserPublicController,
  UsernameController,
} from './controllers';
import {
  NotificationPrefsService,
  ProfileService,
  SessionListService,
  UserActivityService,
  UserDirectoryService,
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
          // `UserDirectoryController` answers the bare `users` path, so it is registered ahead of
          // the `:id` controller for the same reason `profile` and `username` are.
          UserDirectoryController,
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
    UserDirectoryController,
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
    UserDirectoryService,
    UserPublicService,
  ],
  exports: [UserDirectoryService],
})
export class UsersModule {}
