import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { AdminController } from './controllers/admin.controller';
import { AdminGuardService } from './services/admin-guard.service';
import { AdminModerationService } from './services/admin-moderation.service';
import { AdminTaxonomyService } from './services/admin-taxonomy.service';

@Module({
  imports: [
    RouterModule.register([{ path: 'api/v1', module: AdminModule, children: [AdminController] }]),
  ],
  controllers: [AdminController],
  providers: [AdminModerationService, AdminGuardService, AdminTaxonomyService],
  exports: [AdminModerationService],
})
export class AdminModule {}
