import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { BookingController } from './controllers/booking.controller';
import { BriefController } from './controllers/brief.controller';
import { DisputeController } from './controllers/dispute.controller';
import { ProfessionalsController } from './controllers/professionals.controller';
import { ServiceRequestController } from './controllers/service-request.controller';
import { ServiceRequestOfferController } from './controllers/service-request-offer.controller';
import { BriefService } from './services/brief.service';
import { CategoryVerificationService } from './services/category-verification.service';
import { ProfessionalSearchService } from './services/professional-search.service';
import { ServiceCatalogueService } from './services/service-catalogue.service';
import { BrowseService } from './services/browse.service';
import { AvailabilityService } from './services/availability.service';
import { ListingService } from './services/listing.service';
import { ProfessionalsHomeService } from './services/professionals-home.service';
import { ServiceRequestService } from './services/service-request.service';
import { ServiceRequestOfferService } from './services/service-request-offer.service';
import { ProfessionalsCoreModule } from './professionals-core.module';

// Literal-segment controllers come before ProfessionalsController, whose routes end in `:id`.
// `professionals/me/service-request-offers` in particular would otherwise be read as a listing
// whose id is "me".
const CONTROLLERS = [
  ServiceRequestOfferController,
  ServiceRequestController,
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
    // "Let Circl handle it": the member's request and the professional's offer. Two services
    // rather than one, because they are two surfaces with two audiences — what the member may
    // see of an offer is nothing, and keeping that true is easier when the code is apart.
    ServiceRequestService,
    ServiceRequestOfferService,
    // Professionals v2: the service catalogue, the category verifications it is gated by, and the
    // blended search that reads both.
    ServiceCatalogueService,
    CategoryVerificationService,
    ProfessionalSearchService,
  ],
  exports: [
    // The expiry sweep reads it from the jobs module.
    ServiceRequestOfferService,
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
