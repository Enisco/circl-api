import { Global, Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { PulseController } from './controllers/pulse.controller';
import { AutoGuideService } from './services/auto-guide.service';
import { DemandService } from './services/demand.service';
import { FeedRankerService } from './services/feed-ranker.service';
import { GuideMatcherService } from './services/guide-matcher.service';
import { MetricsService } from './services/metrics.service';
import { SmartMatchService } from './services/smart-match.service';

const SERVICES = [
  FeedRankerService,
  GuideMatcherService,
  SmartMatchService,
  DemandService,
  AutoGuideService,
  MetricsService,
];

/**
 * Circl Intelligence — one algorithm, four outputs.
 *
 * Guided Creation (DemandService), Auto-Guides (AutoGuideService), Smart Match
 * (SmartMatchService) and Public Metrics (MetricsService) are all fed by the same
 * behavioural stream, and all four are deterministic: weighted sums, keyword
 * coverage and GROUP BYs. Nothing here calls a model, because every one of these
 * outputs is shown to a member as a fact they can act on.
 *
 * Global because every section reads from it.
 */
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
