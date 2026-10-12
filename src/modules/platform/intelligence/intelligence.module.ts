import { Global, Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { PulseController } from './controllers/pulse.controller';
import { IntelligenceCoreModule } from './intelligence-core.module';
import { DemandService } from './services/demand.service';
import { FeedRankerService } from './services/feed-ranker.service';
import { GuideMatcherService } from './services/guide-matcher.service';
import { MetricsService } from './services/metrics.service';
import { PulseService } from './services/pulse.service';
import { SearchDemandService } from './services/search-demand.service';
import { SmartMatchService } from './services/smart-match.service';
import { MemberActivityService } from './activity/member-activity.service';
import { MemberActivityInterceptor } from './activity/member-activity.interceptor';

/**
 * `AutoGuideService` is deliberately absent: it is provided by `IntelligenceCoreModule`, which
 * this module imports and re-exports. Listing it here as well would construct a second instance,
 * so half the callers would hold one object and half the other — the kind of split that shows up
 * as a service that works everywhere except in one place.
 */
const SERVICES = [
  MemberActivityService,
  FeedRankerService,
  SearchDemandService,
  GuideMatcherService,
  SmartMatchService,
  DemandService,
  MetricsService,
  PulseService,
];

/** Circl Intelligence — one algorithm, four outputs. */
@Global()
@Module({
  imports: [
    IntelligenceCoreModule,
    RouterModule.register([
      { path: 'api/v1', module: IntelligenceModule, children: [PulseController] },
    ]),
  ],
  controllers: [PulseController],
  providers: [...SERVICES, MemberActivityInterceptor],
  exports: [...SERVICES, MemberActivityInterceptor, IntelligenceCoreModule],
})
export class IntelligenceModule {}
