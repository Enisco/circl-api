import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { AdminAuthModule } from './auth/auth.module';

@Module({
  imports: [
    RouterModule.register([
      {
        path: 'api/v1/admin',
        children: [{ path: 'auth', module: AdminAuthModule }],
      },
    ]),
  ],
})
export class AdminModule {}
