import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { FeedController } from './controllers/feed.controller';
import { GroupController } from './controllers/group.controller';
import { GuideController } from './controllers/guide.controller';
import { OfferController } from './controllers/offer.controller';
import { RequestController } from './controllers/request.controller';
import { UpdateController } from './controllers/update.controller';
import { FeedService } from './services/feed.service';
import { GroupService } from './services/group.service';
import { GuideMatchService } from './services/guide-match.service';
import { GuideService } from './services/guide.service';
import { OfferService } from './services/offer.service';
import { RequestResponseService } from './services/request-response.service';
import { RequestService } from './services/request.service';
import { UpdateService } from './services/update.service';

const CONTROLLERS = [
  FeedController,
  RequestController,
  OfferController,
  UpdateController,
  GuideController,
  GroupController,
];

@Module({
  imports: [
    RouterModule.register([{ path: 'api/v1', module: CommunityModule, children: CONTROLLERS }]),
  ],
  controllers: CONTROLLERS,
  providers: [
    FeedService,
    RequestService,
    RequestResponseService,
    OfferService,
    UpdateService,
    GuideService,
    GuideMatchService,
    GroupService,
  ],
  exports: [RequestService, OfferService, GuideService, GroupService],
})
export class CommunityModule {}
