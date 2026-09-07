import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { UsersModule } from '@/modules/core/users/users.module';
import { CommunityModule } from '../community/community.module';
import { ConnectModule } from '../connect/connect.module';
import { CommerceModule } from '../commerce/commerce.module';
import { ProfessionalsModule } from '../professionals/professionals.module';
import { SearchController } from './controllers/search.controller';
import { SearchService } from './services/search.service';

/** The unified search endpoint (G8). */
@Module({
  imports: [
    // For the PERSON resolver. The directory lives with the users because `GET /users?q=` is its
    // paginated half, and a search module owning a user endpoint would be the wrong way round.
    UsersModule,
    CommunityModule,
    ConnectModule,
    CommerceModule,
    ProfessionalsModule,
    RouterModule.register([{ path: 'api/v1', module: SearchModule, children: [SearchController] }]),
  ],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
