import { Global, Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { PulseController } from './controllers/pulse.controller';
import { AutoGuideService } from './services/auto-guide.service';
import { DemandService } from './services/demand.service';
import { FeedRankerService } from './services/feed-ranker.service';
import { GuideMatcherService } from './services/guide-matcher.service';
import { MetricsService } from './services/metrics.service';
import { PulseService } from './services/pulse.service';
import { SmartMatchService } from './services/smart-match.service';

const SERVICES = [
  FeedRankerService,
  GuideMatcherService,
  SmartMatchService,
  DemandService,
  AutoGuideService,
  MetricsService,
  PulseService,
];

/** Circl Intelligence — one algorithm, four outputs. */
@Global()
@Module({
  imports: [
    RouterModule.register([
      { path: 'api/v1', module: IntelligenceModule, children: [PulseController] },
    ]),
  ],
  controllers: [PulseController],
  providers: SERVICES,
  exports: SERVICES,
})
export class IntelligenceModule {}
