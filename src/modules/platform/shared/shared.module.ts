import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Storage, StorageProvider } from '../media/storage';
import { CityCompatMiddleware, ReportCompatMiddleware } from './middlewares';
import {
  ActivityService,
  BlockingService,
  CityService,
  MediaService,
  RiskScannerService,
  TaxonomyService,
} from './services';

const SERVICES = [
  ActivityService,
  BlockingService,
  CityService,
  MediaService,
  RiskScannerService,
  TaxonomyService,
];

/** The services every platform section reads. */
@Global()
@Module({
  providers: [
    ...SERVICES,
    CityCompatMiddleware,
    ReportCompatMiddleware,
    {
      // S3 is the only driver.
      provide: StorageProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService): StorageProvider => new S3Storage(config),
    },
  ],
  exports: [...SERVICES, CityCompatMiddleware, ReportCompatMiddleware, StorageProvider],
})
export class PlatformSharedModule {}
