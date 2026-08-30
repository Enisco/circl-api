import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { BookingController } from './controllers/booking.controller';
import { BriefController } from './controllers/brief.controller';
import { DisputeController } from './controllers/dispute.controller';
import { ProfessionalsController } from './controllers/professionals.controller';
import { BookingService } from './services/booking.service';
import { BriefService } from './services/brief.service';
import { BrowseService } from './services/browse.service';
import { DisputeService } from './services/dispute.service';
import { AvailabilityService } from './services/availability.service';
import { ListingService } from './services/listing.service';
import { ProfessionalsHomeService } from './services/professionals-home.service';

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
  ],
  controllers: CONTROLLERS,
  providers: [
    AvailabilityService,
    ListingService,
    BrowseService,
    ProfessionalsHomeService,
    BookingService,
    BriefService,
    DisputeService,
  ],
  exports: [ListingService, BookingService, DisputeService, ProfessionalsHomeService, BrowseService],
})
export class ProfessionalsModule {}
