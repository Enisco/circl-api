import { Global, Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { ReviewController } from './controllers/review.controller';
import { VerificationController } from './controllers/verification.controller';
import { ReputationService } from './services/reputation.service';
import { ReviewService } from './services/review.service';
import { VerificationService } from './services/verification.service';

const CONTROLLERS = [ReviewController, VerificationController];

/**
 * Circl Trust.
 *
 * Global because reputation and trust checks hang off the USER and are read by
 * Professionals, Connect and Commerce alike — scoping them under one section is
 * how a trusted member arrives in the next section looking like a stranger.
 */
@Global()
@Module({
  imports: [
    RouterModule.register([{ path: 'api/v1', module: TrustModule, children: CONTROLLERS }]),
  ],
  controllers: CONTROLLERS,
  providers: [ReviewService, ReputationService, VerificationService],
  exports: [ReviewService, ReputationService, VerificationService],
})
export class TrustModule {}
