import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { DealController } from './controllers/deal.controller';
import { DealService } from './services/deal.service';

/** Deal progress and the section analytics built from it. */
@Module({
  imports: [
    RouterModule.register([{ path: 'api/v1', module: DealsModule, children: [DealController] }]),
  ],
  controllers: [DealController],
  providers: [DealService],
  exports: [DealService],
})
export class DealsModule {}
