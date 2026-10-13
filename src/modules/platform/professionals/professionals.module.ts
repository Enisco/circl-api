import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { BookingController } from './controllers/booking.controller';
import { BriefController } from './controllers/brief.controller';
import { DisputeController } from './controllers/dispute.controller';
import { ProfessionalsController } from './controllers/professionals.controller';
import { BriefService } from './services/brief.service';
import { CategoryVerificationService } from './services/category-verification.service';
import { ProfessionalSearchService } from './services/professional-search.service';
import { ServiceCatalogueService } from './services/service-catalogue.service';
import { BrowseService } from './services/browse.service';
import { AvailabilityService } from './services/availability.service';
import { ListingService } from './services/listing.service';
import { ProfessionalsHomeService } from './services/professionals-home.service';
import { ProfessionalsCoreModule } from './professionals-core.module';

// BriefController is registered before ProfessionalsController so /professionals/briefs/...
const CONTROLLERS = [
  BriefController,
  ProfessionalsController,
  BookingController,
  DisputeController,
];

@Module({
  imports: [
    RouterModule.register([{ path: 'api/v1', module: ProfessionalsModule, children: CONTROLLERS }]),
    // The two services the admin surface also needs, declared once. Imported rather than listed
    // again below: two providers of one class are two instances, and a booking created by the one
    // the admin process holds would be invisible to the caches the member one keeps.
    ProfessionalsCoreModule,
  ],
  controllers: CONTROLLERS,
  providers: [
    AvailabilityService,
    ListingService,
    BrowseService,
    ProfessionalsHomeService,
    BriefService,
    // Professionals v2: the service catalogue, the category verifications it is gated by, and the
    // blended search that reads both.
    ServiceCatalogueService,
    CategoryVerificationService,
    ProfessionalSearchService,
  ],
  exports: [
    ListingService,
    ProfessionalsHomeService,
    BrowseService,
    // Exported for the admin surface's review queue, which decides these records (v2 §12).
    CategoryVerificationService,
    ServiceCatalogueService,
    // The module rather than the two services: they are provided by it now, and Nest refuses to
    // re-export a provider a module does not own. Importers of `ProfessionalsModule` still get
    // `BookingService` and `DisputeService`, which is what they were getting before.
    ProfessionalsCoreModule,
  ],
})
export class ProfessionalsModule {}
