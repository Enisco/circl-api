import { Global, Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { ReviewController } from './controllers/review.controller';
import { VerificationController } from './controllers/verification.controller';
import { ReputationService } from './services/reputation.service';
import { ReviewService } from './services/review.service';
import { VerificationService } from './services/verification.service';

const CONTROLLERS = [ReviewController, VerificationController];

/** Circl Trust. */
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
