import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { AccountCoreModule } from './account-core.module';
import { AccountController } from './controllers/account.controller';
import { AccountSettingsController } from './controllers/data-export.controller';
import { PrivacyController } from './controllers/privacy.controller';

/** Account deletion (0.15), privacy, data export and email change (G7, G9, G10). */
@Module({
  imports: [
    AccountCoreModule,
    RouterModule.register([
      {
        path: 'api/v1',
        module: AccountModule,
        children: [AccountController, PrivacyController, AccountSettingsController],
      },
    ]),
  ],
  controllers: [AccountController, PrivacyController, AccountSettingsController],
  // The services come from `AccountCoreModule`, which has no routes of its own — see the comment
  // there. Re-exported so importers of this module keep working unchanged.
  exports: [AccountCoreModule],
})
export class AccountModule {}
