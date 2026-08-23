import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { ProfessionalsModule } from '../professionals/professionals.module';
import { CommerceController } from './controllers/commerce.controller';
import { ManagedRequestController } from './controllers/managed-request.controller';
import { AiDraftService } from './services/ai-draft.service';
import { CommerceBrowseService } from './services/commerce-browse.service';
import { EnquiryService } from './services/enquiry.service';
import { ItemService } from './services/item.service';
import { ManagedRequestService } from './services/managed-request.service';
import { StoreService } from './services/store.service';

const CONTROLLERS = [CommerceController, ManagedRequestController];

@Module({
  // Commerce reuses the booking machine's dispute resource rather than adding a
  // second one (4.1.3). If the two drifted, "Report a problem" would behave
  // differently depending on which half of the app you were in.
  imports: [
    ProfessionalsModule,
    RouterModule.register([{ path: 'api/v1', module: CommerceModule, children: CONTROLLERS }]),
  ],
  controllers: CONTROLLERS,
  providers: [
    StoreService,
    ItemService,
    CommerceBrowseService,
    EnquiryService,
    AiDraftService,
    ManagedRequestService,
  ],
  exports: [StoreService, EnquiryService],
})
export class CommerceModule {}
