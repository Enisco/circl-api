import { Global, Module } from '@nestjs/common';
import {
  ActivityService,
  BlockingService,
  CityService,
  MediaService,
  RiskScannerService,
  TaxonomyService,
} from './services';

/**
 * The services every platform section reads.
 *
 * Global because the alternative is importing the same six providers into ten
 * modules, and because taxonomy and city hold process-level caches that are only
 * worth holding once.
 */
@Global()
@Module({
  providers: [
    ActivityService,
    BlockingService,
    CityService,
    MediaService,
    RiskScannerService,
    TaxonomyService,
  ],
  exports: [
    ActivityService,
    BlockingService,
    CityService,
    MediaService,
    RiskScannerService,
    TaxonomyService,
  ],
})
export class PlatformSharedModule {}
