import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { AccountController } from './controllers/account.controller';
import { AccountDeletionService } from './services/account-deletion.service';

/** Account deletion (0.15). */
@Module({
  imports: [
    RouterModule.register([
      { path: 'api/v1', module: AccountModule, children: [AccountController] },
    ]),
  ],
  controllers: [AccountController],
  providers: [AccountDeletionService],
  exports: [AccountDeletionService],
})
export class AccountModule {}
