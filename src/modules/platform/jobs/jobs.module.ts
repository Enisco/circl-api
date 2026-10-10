import { Module } from '@nestjs/common';
import { CommerceModule } from '../commerce/commerce.module';
import { MediaModule } from '../media/media.module';
import { ProfessionalsModule } from '../professionals/professionals.module';
import { PlatformJobsService } from './platform-jobs.service';

@Module({
  imports: [MediaModule, ProfessionalsModule, CommerceModule],
  providers: [PlatformJobsService],
  exports: [PlatformJobsService],
})
export class PlatformJobsModule {}
