import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { ModerationController } from './controllers/moderation.controller';
import { ModerationCoreModule } from './moderation-core.module';

@Module({
  imports: [
    ModerationCoreModule,
    RouterModule.register([
      { path: 'api/v1', module: ModerationModule, children: [ModerationController] },
    ]),
  ],
  controllers: [ModerationController],
  // Provided by the core module rather than here, so the member surface and the admin surface
  // share one instance of each. Two copies of `ReportCaseService` would be two caches of
  // `reports.slaMinutes` and, more to the point, two things that think they own §4.6's
  // one-open-case-per-target rule.
  exports: [ModerationCoreModule],
})
export class ModerationModule {}
