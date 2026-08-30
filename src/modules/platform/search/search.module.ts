import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { CommunityModule } from '../community/community.module';
import { ConnectModule } from '../connect/connect.module';
import { CommerceModule } from '../commerce/commerce.module';
import { ProfessionalsModule } from '../professionals/professionals.module';
import { SearchController } from './controllers/search.controller';
import { SearchService } from './services/search.service';

/** The unified search endpoint (G8). */
@Module({
  imports: [
    CommunityModule,
    ConnectModule,
    CommerceModule,
    ProfessionalsModule,
    RouterModule.register([
      { path: 'api/v1', module: SearchModule, children: [SearchController] },
    ]),
  ],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
