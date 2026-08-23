import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CommerceModule } from '../commerce/commerce.module';
import { MediaModule } from '../media/media.module';
import { ProfessionalsModule } from '../professionals/professionals.module';
import { PlatformJobsService } from './platform-jobs.service';

@Module({
  imports: [ScheduleModule.forRoot(), MediaModule, ProfessionalsModule, CommerceModule],
  providers: [PlatformJobsService],
})
export class PlatformJobsModule {}
