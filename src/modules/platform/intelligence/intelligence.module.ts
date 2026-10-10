import { Global, Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { PulseController } from './controllers/pulse.controller';
import { AutoGuideService } from './services/auto-guide.service';
import { DemandService } from './services/demand.service';
import { FeedRankerService } from './services/feed-ranker.service';
import { GuideMatcherService } from './services/guide-matcher.service';
import { MetricsService } from './services/metrics.service';
import { PulseService } from './services/pulse.service';
import { SearchDemandService } from './services/search-demand.service';
import { SmartMatchService } from './services/smart-match.service';
import { MemberActivityService } from './activity/member-activity.service';
import { MemberActivityInterceptor } from './activity/member-activity.interceptor';

const SERVICES = [
  MemberActivityService,
  FeedRankerService,
  SearchDemandService,
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
  providers: [...SERVICES, MemberActivityInterceptor],
  exports: [...SERVICES, MemberActivityInterceptor],
})
export class IntelligenceModule {}
