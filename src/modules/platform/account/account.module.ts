import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { AccountController } from './controllers/account.controller';
import { AccountSettingsController } from './controllers/data-export.controller';
import { PrivacyController } from './controllers/privacy.controller';
import { AccountDeletionService } from './services/account-deletion.service';
import { DataExportService } from './services/data-export.service';
import { EmailChangeService } from './services/email-change.service';
import { PrivacyService } from './services/privacy.service';

/** Account deletion (0.15), privacy, data export and email change (G7, G9, G10). */
@Module({
  imports: [
    RouterModule.register([
      {
        path: 'api/v1',
        module: AccountModule,
        children: [AccountController, PrivacyController, AccountSettingsController],
      },
    ]),
  ],
  controllers: [AccountController, PrivacyController, AccountSettingsController],
  providers: [AccountDeletionService, PrivacyService, DataExportService, EmailChangeService],
  exports: [AccountDeletionService, PrivacyService],
})
export class AccountModule {}
