import { Module } from '@nestjs/common';
import { AccountDeletionService } from './services/account-deletion.service';
import { DataExportService } from './services/data-export.service';
import { EmailChangeService } from './services/email-change.service';
import { PrivacyService } from './services/privacy.service';

const SERVICES = [AccountDeletionService, PrivacyService, DataExportService, EmailChangeService];

/**
 * Account deletion, privacy, data export and email change — the services, with no routes.
 *
 * Split out from `AccountModule` so the admin surface can hold these four without also mounting the
 * three member controllers that sit on top of them. A staff process serving
 * `DELETE /account` would be a member-facing endpoint in a place nobody is looking for one, and a
 * staff member's token reaching it is a question nobody should have to answer.
 *
 * `AccountModule` imports this and adds the controllers, so there is one copy of each service and
 * the member API is unchanged.
 */
@Module({ providers: SERVICES, exports: SERVICES })
export class AccountCoreModule {}
