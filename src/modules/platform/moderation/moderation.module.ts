import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { ModerationController } from './controllers/moderation.controller';
import { ModerationService } from './services/moderation.service';

@Module({
  imports: [
    RouterModule.register([
      { path: 'api/v1', module: ModerationModule, children: [ModerationController] },
    ]),
  ],
  controllers: [ModerationController],
  providers: [ModerationService],
  exports: [ModerationService],
})
export class ModerationModule {}
