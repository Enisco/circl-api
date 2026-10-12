import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiModule } from '@/modules/infrastructure/ai/ai.module';
import { MediaDerivationService } from '../media/derivation/media-derivation.service';
import { S3Storage, StorageProvider } from '../media/storage';
import {
  CityCompatMiddleware,
  ReportCompatMiddleware,
  TaxonomyCompatMiddleware,
} from './middlewares';
import {
  ActivityService,
  BadgeService,
  BlockingService,
  CONTENT_SAFETY_QUEUE,
  CityService,
  ContentReviewService,
  ContentSafetyProcessor,
  ContentSafetyQueue,
  ContentSafetyService,
  ListingDocumentService,
  ListingReviewService,
  MESSAGE_SAFETY_QUEUE,
  MediaService,
  MessageSafetyProcessor,
  MessageSafetyQueue,
  MessageSafetyService,
  QueueDeadlineService,
  RiskScannerService,
  SafetyClassifierService,
  SessionRevocationService,
  SystemConfigService,
  TaxonomyService,
} from './services';

const SERVICES = [
  ActivityService,
  BadgeService,
  BlockingService,
  CityService,
  ContentReviewService,
  ContentSafetyProcessor,
  ContentSafetyQueue,
  ContentSafetyService,
  ListingDocumentService,
  ListingReviewService,
  MediaDerivationService,
  MediaService,
  MessageSafetyProcessor,
  MessageSafetyQueue,
  MessageSafetyService,
  QueueDeadlineService,
  RiskScannerService,
  SafetyClassifierService,
  SessionRevocationService,
  SystemConfigService,
  TaxonomyService,
];

/** The services every platform section reads. */
@Global()
@Module({
  imports: [
    AiModule,
    // The scan queue §6.2 names. Registered here, in the module every section imports, because
    // the write paths that fill it and the read paths that honour its verdict are both in the
    // platform — and because a worker deployment of its own would be a second place to configure
    // the same thing.
    BullModule.registerQueue({ name: CONTENT_SAFETY_QUEUE }),
    BullModule.registerQueue({ name: MESSAGE_SAFETY_QUEUE }),
  ],
  providers: [
    ...SERVICES,
    CityCompatMiddleware,
    ReportCompatMiddleware,
    TaxonomyCompatMiddleware,
    {
      // S3 is the only driver.
      provide: StorageProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService): StorageProvider => new S3Storage(config),
    },
  ],
  exports: [
    ...SERVICES,
    CityCompatMiddleware,
    ReportCompatMiddleware,
    TaxonomyCompatMiddleware,
    StorageProvider,
  ],
})
export class PlatformSharedModule {}
