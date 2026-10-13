import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { AppPolicyController } from './app-policy.controller';
import { AppPolicyCoreModule } from './app-policy-core.module';

/**
 * §5.21's public version gate, with its route.
 *
 * The member surface only. The admin surface imports `AppPolicyCoreModule` instead, because a
 * staff process serving `GET /app/version-policy` would be a member endpoint in a place nobody is
 * looking for one — the same reason `GuardCoreModule` and `ModerationCoreModule` exist. The
 * surface test caught this: it asserts the admin host mounts nothing but admin routes, and the
 * first version of this module mounted one.
 */
@Module({
  imports: [
    AppPolicyCoreModule,
    RouterModule.register([
      { path: 'api/v1', module: AppPolicyModule, children: [AppPolicyController] },
    ]),
  ],
  controllers: [AppPolicyController],
  exports: [AppPolicyCoreModule],
})
export class AppPolicyModule {}
