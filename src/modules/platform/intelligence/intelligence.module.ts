import { Global, Module } from '@nestjs/common';
import { FeedRankerService } from './services/feed-ranker.service';
import { GuideMatcherService } from './services/guide-matcher.service';
import { SmartMatchService } from './services/smart-match.service';

/**
 * Circl Intelligence — one algorithm, four outputs.
 *
 * Global because every section reads from it: the feed ranks with it, the
 * composer asks it what is in demand locally, the managed brief scores against
 * it, and the Pulse dashboards are the same data in a fourth shape.
 */
@Global()
@Module({
  providers: [FeedRankerService, GuideMatcherService, SmartMatchService],
  exports: [FeedRankerService, GuideMatcherService, SmartMatchService],
})
export class IntelligenceModule {}
