import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { TaxonomyController } from './controllers/taxonomy.controller';
import { TaxonomyCatalogueService } from './services/taxonomy-catalogue.service';

@Module({
  imports: [
    RouterModule.register([
      { path: 'api/v1', module: TaxonomyModule, children: [TaxonomyController] },
    ]),
  ],
  controllers: [TaxonomyController],
  providers: [TaxonomyCatalogueService],
  exports: [TaxonomyCatalogueService],
})
export class TaxonomyModule {}
