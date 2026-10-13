import { Module } from '@nestjs/common';
import { ModerationService } from './services/moderation.service';
import { ReportCaseService } from './services/report-case.service';

/**
 * Report filing and §7.1's case grouping — the services, with no routes.
 *
 * Split out from `ModerationModule` so the admin surface can file a **staff** report without also
 * mounting `ModerationController`. A staff process serving `POST /moderation/reports` would be a
 * member endpoint in a place nobody is looking for one — the same reason `GuardCoreModule` and
 * `AccountCoreModule` exist.
 *
 * §5.10's escalations need it: an escalation with a target files a staff report into the case, and
 * "file a report" is not one write. It resolves the target (including an anonymous post's report
 * token), snapshots the content so a later deletion cannot erase the evidence, re-scans it, groups
 * it into the open case or answers it from a decided one, and retries the whole transaction if it
 * loses §4.6's one-open-case-per-target race. A second copy of that in the admin service would be
 * a second place for §7.1 to drift, and the failure mode is a staff escalation that opens a case
 * the member-facing path would have grouped.
 */
@Module({
  providers: [ModerationService, ReportCaseService],
  exports: [ModerationService, ReportCaseService],
})
export class ModerationCoreModule {}
