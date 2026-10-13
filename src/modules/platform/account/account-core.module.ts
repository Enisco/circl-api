import { Module } from '@nestjs/common';
import { NotificationModule } from '@/modules/infrastructure/notification/notification.module';
import { AccountDeletionService } from './services/account-deletion.service';
import { DataExportBuilderService } from './services/data-export-builder.service';
import { DataExportService } from './services/data-export.service';
import { EmailChangeService } from './services/email-change.service';
import { PrivacyService } from './services/privacy.service';

const SERVICES = [
  AccountDeletionService,
  PrivacyService,
  DataExportService,
  // B16: the builder that assembles the archive. Here rather than in the jobs module because it
  // is the data export's own logic — the job is a five-minute `@Cron` that calls one method.
  DataExportBuilderService,
  EmailChangeService,
];

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
// `NotificationModule` for the provider that emails the member their link.
@Module({ imports: [NotificationModule], providers: SERVICES, exports: SERVICES })
export class AccountCoreModule {}
