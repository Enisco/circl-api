import { BullModule } from '@nestjs/bullmq';
import { MiddlewareConsumer, Module, RequestMethod } from '@nestjs/common';
import { DiscoveryModule, RouterModule } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { NotificationModule } from '@/modules/infrastructure/notification/notification.module';
import { AccountCoreModule } from '@/modules/platform/account';
import { MessagingCoreModule } from '@/modules/platform/messaging';
import { MediaCoreModule } from '@/modules/platform/media';
import { GuardCoreModule } from '@/modules/platform/guard';
import { ModerationCoreModule } from '@/modules/platform/moderation';
import { ProfessionalsCoreModule } from '@/modules/platform/professionals';
import { IntelligenceCoreModule } from '@/modules/platform/intelligence';
import { AdminController } from './controllers/admin.controller';
import { AdminAuthController } from './controllers/admin-auth.controller';
import { AdminMeController } from './controllers/admin-me.controller';
import { AdminAnalyticsController } from './controllers/admin-analytics.controller';
import { AdminExportController } from './controllers/admin-export.controller';
import { AdminMemberActionController } from './controllers/admin-member-action.controller';
import { AdminMemberController } from './controllers/admin-member.controller';
import { AdminNoteController } from './controllers/admin-note.controller';
import { AdminContentController } from './content/admin-content.controller';
import { AdminGuideController } from './content/admin-guide.controller';
import { AdminGuideService } from './content/admin-guide.service';
import { AdminContentService } from './content/admin-content.service';
import { AdminEnforcementController } from './controllers/admin-enforcement.controller';
import { AdminFlagController } from './controllers/admin-flag.controller';
import { AdminQueueController } from './controllers/admin-queue.controller';
import { AdminQueueService } from './services/admin-queue.service';
import { AdminAnnouncementService } from './comms/admin-announcement.service';
import { AnnouncementFanoutService } from './comms/announcement-fanout.service';
import { AnnouncementProcessor } from './comms/announcement.processor';
import { ANNOUNCEMENTS_QUEUE, AnnouncementQueue } from './comms/announcement.queue';
import { AdminConfigService } from './services/admin-config.service';
import { AdminDisputeService } from './services/admin-dispute.service';
import { AdminManagedService } from './services/admin-managed.service';
import { AdminPlacesService } from './services/admin-places.service';
import { AdminThreadAccessService } from './services/admin-thread-access.service';
import { AdminEnforcementService } from './services/admin-enforcement.service';
import { AdminContentTargetService } from './services/admin-content-target.service';
import { AdminListingReviewController } from './controllers/admin-listing-review.controller';
import { AdminListingReviewService } from './services/admin-listing-review.service';
import { AdminAppealController } from './controllers/admin-appeal.controller';
import { AdminEscalationController } from './controllers/admin-escalation.controller';
import { AdminReportController } from './controllers/admin-report.controller';
import { AdminMetaController } from './controllers/admin-meta.controller';
import { AdminTeamController } from './controllers/admin-team.controller';
import { AdminThreadController } from './controllers/admin-thread.controller';
import { AdminAnnouncementController } from './controllers/admin-announcement.controller';
import { AdminConfigController } from './controllers/admin-config.controller';
import { AdminDisputeController } from './controllers/admin-dispute.controller';
import { AdminManagedController } from './controllers/admin-managed.controller';
import { AdminPlacesController } from './controllers/admin-places.controller';
import { AdminSupportController } from './controllers/admin-support.controller';
import { AdminMediaController } from './controllers/admin-media.controller';
import { AdminAuditController } from './controllers/admin-audit.controller';
import { AdminJobController } from './controllers/admin-job.controller';
import { AdminEnforcementLogService } from './services/admin-enforcement-log.service';
import { AdminFlagService } from './services/admin-flag.service';
import { AdminGuardService } from './services/admin-guard.service';
import { AdminHistoryService } from './services/admin-history.service';
import { AdminMemberService } from './services/admin-member.service';
import { AdminAppealService } from './services/admin-appeal.service';
import { AdminEscalationService } from './services/admin-escalation.service';
import { AdminSupportService } from './services/admin-support.service';
import { AdminAuditService } from './services/admin-audit.service';
import { AdminJobReadService } from './services/admin-job-read.service';
import { AdminReportCaseService } from './services/admin-report-case.service';
import { AdminAnalyticsService } from './services/admin-analytics.service';
import { AdminDashboardService } from './services/admin-dashboard.service';
import { AdminMemberActionService } from './services/admin-member-action.service';
import { AdminMemberTabsService } from './services/admin-member-tabs.service';
import { AdminNoteService } from './services/admin-note.service';
import { AdminModerationService } from './services/admin-moderation.service';
import { AdminTaxonomyService } from './services/admin-taxonomy.service';
import { AdminMeService } from './services/admin-me.service';
import { AdminTeamService } from './services/admin-team.service';
import { EnforcementService } from './services/enforcement.service';
import { AuditChainService } from './audit/audit-chain.service';
import { AuditService } from './audit/audit.service';
import { AdminAuthService } from './auth/admin-auth.service';
import { AdminInviteService } from './auth/admin-invite.service';
import { AdminJwtStrategy } from './auth/admin-jwt.strategy';
import { AdminMailService } from './auth/admin-mail.service';
import { AdminPasswordService } from './auth/admin-password.service';
import { AdminPermissionService } from './auth/admin-permission.service';
import { AdminRecoveryCodeService } from './auth/admin-recovery-code.service';
import { AdminSessionService } from './auth/admin-session.service';
import { AdminTotpService } from './auth/admin-totp.service';
import { AdminBffGuard } from './common/admin-bff.guard';
import { AdminClientContextMiddleware } from './common/admin-context';
import { AdminPermissionGuard } from './common/admin-permission.guard';
import { AdminPolicyService } from './common/admin-policy.service';
import { AdminRouteAuditService } from './common/admin-route-audit.service';
import { AnalyticsRunnerService } from './analytics/analytics-runner.service';
import { DemographicsAnalytics } from './analytics/demographics.analytics';
import { CommerceAnalytics } from './analytics/commerce.analytics';
import { CommunityAnalytics } from './analytics/community.analytics';
import { ConnectAnalytics } from './analytics/connect.analytics';
import { DealsAnalytics } from './analytics/deals.analytics';
import { ProfessionalsAnalytics } from './analytics/professionals.analytics';
import { AdminAssigneeService } from './services/admin-assignee.service';
import { AdminFilterOptionsService } from './services/admin-filter-options.service';
import { AdminSearchService } from './services/admin-search.service';
import { SafetyAnalytics } from './analytics/safety.analytics';
import { SearchAnalytics } from './analytics/search.analytics';
import { SupportAnalytics } from './analytics/support.analytics';
import { GrowthAnalytics } from './analytics/growth.analytics';
import { OverviewAnalytics } from './analytics/overview.analytics';
import { MemberFilterBuilder } from './filters/member-filter.builder';
import { ADMIN_EXPORTS_QUEUE, AdminExportQueue } from './exports/admin-export.queue';
import { AdminExportProcessor } from './exports/admin-export.processor';
import { AdminExportRunner } from './exports/admin-export-runner.service';
import { AdminExportService } from './exports/admin-export.service';
import { AdminJobRunnerService } from './jobs/admin-job-runner.service';
import { AdminJobsService } from './jobs/admin-jobs.service';
import { RetentionPurgeService } from './jobs/retention-purge.service';

const CONTROLLERS = [
  AdminAuthController,
  AdminMeController,
  AdminTeamController,
  AdminMemberController,
  AdminMemberActionController,
  AdminAnalyticsController,
  AdminNoteController,
  AdminAppealController,
  AdminListingReviewController,
  AdminQueueController,
  AdminFlagController,
  AdminContentController,
  AdminGuideController,
  AdminEnforcementController,
  AdminEscalationController,
  AdminReportController,
  AdminMetaController,
  AdminExportController,
  AdminThreadController,
  AdminAnnouncementController,
  AdminConfigController,
  AdminDisputeController,
  AdminManagedController,
  AdminPlacesController,
  AdminSupportController,
  AdminMediaController,
  AdminAuditController,
  AdminJobController,
  AdminController,
];

/**
 * One module owns the whole admin surface, so one guard stack covers it.
 *
 * `DiscoveryModule` is here for `AdminRouteAuditService`, which walks every admin handler at
 * startup and refuses to boot if one does not say who may call it.
 */
@Module({
  imports: [
    DiscoveryModule,
    PassportModule,
    JwtModule.register({}),
    NotificationModule,
    MessagingCoreModule,
    // `MediaUploadService`, for `POST admin/media/uploads` — the staff door onto the upload
    // tickets a reply's attachments need. The core module, so the member upload route is not
    // mounted on a staff process (it is guarded by the member JWT and would answer a 500 there).
    MediaCoreModule,
    AccountCoreModule,
    // §5.12's escalation opens the member's existing Guard thread, and that rule lives in
    // `GuardService`. The core module, so no member Guard route is mounted here.
    GuardCoreModule,
    // `AutoGuideService`, for publishing a draft guide a reviewer approved (§5.9).
    IntelligenceCoreModule,
    // §5.10's escalations file a **staff** report into the target's case, through the same path a
    // member's report takes. The core module, so no member `POST /moderation/reports` is mounted
    // on a staff process.
    ModerationCoreModule,
    // §5.16 places a brief by creating the booking the member would have created themselves, and
    // §5.17 reads a dispute's subject. The core module, so `ProfessionalsModule`'s four member
    // controllers are not mounted on a staff process.
    ProfessionalsCoreModule,
    // The export queue is registered here, by the admin module, so a member-only process has
    // neither the producer nor a worker for it: an export reads member data under a staff
    // member's permissions, and the member API has no business being able to build one.
    BullModule.registerQueue({ name: ADMIN_EXPORTS_QUEUE }),
    // §5.18's fan-out, registered here for the same reason: an announcement goes out under a
    // staff member's authority, and the member process has no business being able to start one.
    BullModule.registerQueue({ name: ANNOUNCEMENTS_QUEUE }),
    RouterModule.register([{ path: 'api/v1', module: AdminModule, children: CONTROLLERS }]),
  ],
  controllers: CONTROLLERS,
  providers: [
    // Guards and the strategy they depend on.
    AdminBffGuard,
    AdminJwtStrategy,
    AdminPermissionGuard,
    AdminRouteAuditService,
    AdminJobRunnerService,
    AdminJobsService,
    RetentionPurgeService,

    // Authentication.
    AdminAuthService,
    AdminPasswordService,
    AdminTotpService,
    AdminRecoveryCodeService,
    AdminSessionService,
    AdminPermissionService,
    AdminInviteService,
    AdminMailService,

    // Shared.
    AuditService,
    AuditChainService,
    AdminPolicyService,
    MemberFilterBuilder,
    AnalyticsRunnerService,
    OverviewAnalytics,
    DemographicsAnalytics,
    GrowthAnalytics,
    CommunityAnalytics,
    DealsAnalytics,
    ConnectAnalytics,
    CommerceAnalytics,
    ProfessionalsAnalytics,
    AdminAssigneeService,
    AdminFilterOptionsService,
    AdminSearchService,
    SafetyAnalytics,
    SearchAnalytics,
    SupportAnalytics,

    // Exports.
    AdminExportService,
    AdminExportQueue,
    AdminExportRunner,
    AdminExportProcessor,

    // Surfaces.
    AdminMeService,
    AdminTeamService,
    AdminMemberService,
    AdminMemberTabsService,
    AdminMemberActionService,
    AdminNoteService,
    AdminAppealService,
    AdminListingReviewService,
    AdminQueueService,
    AdminAnnouncementService,
    AnnouncementFanoutService,
    AnnouncementProcessor,
    AnnouncementQueue,
    AdminConfigService,
    AdminDisputeService,
    AdminManagedService,
    AdminPlacesService,
    AdminThreadAccessService,
    AdminContentTargetService,
    AdminEnforcementService,
    AdminEscalationService,
    AdminSupportService,
    AdminAuditService,
    AdminJobReadService,
    AdminReportCaseService,
    AdminAnalyticsService,
    AdminDashboardService,
    EnforcementService,
    AdminModerationService,
    AdminContentService,
    AdminGuideService,
    AdminEnforcementLogService,
    AdminFlagService,
    AdminGuardService,
    AdminHistoryService,
    AdminTaxonomyService,
  ],
  exports: [AdminModerationService, AuditService, EnforcementService],
})
export class AdminModule {
  configure(consumer: MiddlewareConsumer) {
    // Only the admin routes. It establishes the request context every audit entry reads and sets
    // the no-store headers, neither of which belongs on a member response.
    consumer
      .apply(AdminClientContextMiddleware)
      .forRoutes({ path: 'api/v1/admin/*path', method: RequestMethod.ALL });
  }
}
