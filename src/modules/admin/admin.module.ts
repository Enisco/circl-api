import { MiddlewareConsumer, Module, RequestMethod } from '@nestjs/common';
import { DiscoveryModule, RouterModule } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { NotificationModule } from '@/modules/infrastructure/notification/notification.module';
import { MessagingCoreModule } from '@/modules/platform/messaging';
import { AdminController } from './controllers/admin.controller';
import { AdminAuthController } from './controllers/admin-auth.controller';
import { AdminMeController } from './controllers/admin-me.controller';
import { AdminMetaController } from './controllers/admin-meta.controller';
import { AdminTeamController } from './controllers/admin-team.controller';
import { AdminThreadController } from './controllers/admin-thread.controller';
import { AdminGuardService } from './services/admin-guard.service';
import { AdminModerationService } from './services/admin-moderation.service';
import { AdminTaxonomyService } from './services/admin-taxonomy.service';
import { AdminMeService } from './services/admin-me.service';
import { AdminTeamService } from './services/admin-team.service';
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
import { AdminJobRunnerService } from './jobs/admin-job-runner.service';

const CONTROLLERS = [
  AdminAuthController,
  AdminMeController,
  AdminTeamController,
  AdminMetaController,
  AdminThreadController,
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
    AdminPolicyService,

    // Surfaces.
    AdminMeService,
    AdminTeamService,
    AdminModerationService,
    AdminGuardService,
    AdminTaxonomyService,
  ],
  exports: [AdminModerationService, AuditService],
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
