import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { ModerationController } from './controllers/moderation.controller';
import { ModerationService } from './services/moderation.service';
import { ReportCaseService } from './services/report-case.service';

@Module({
  imports: [
    RouterModule.register([
      { path: 'api/v1', module: ModerationModule, children: [ModerationController] },
    ]),
  ],
  controllers: [ModerationController],
  providers: [ModerationService, ReportCaseService],
  exports: [ModerationService, ReportCaseService],
})
export class ModerationModule {}
