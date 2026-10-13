import { Module } from '@nestjs/common';
import { AccountCoreModule } from '../account/account-core.module';
import { CommerceModule } from '../commerce/commerce.module';
import { MediaModule } from '../media/media.module';
import { ProfessionalsModule } from '../professionals/professionals.module';
import { PlatformJobsService } from './platform-jobs.service';

@Module({
  // `AccountCoreModule` for the data export builder (B16). The core module, not `AccountModule`:
  // the job runner has no business mounting the member's account routes.
  imports: [MediaModule, ProfessionalsModule, CommerceModule, AccountCoreModule],
  providers: [PlatformJobsService],
  exports: [PlatformJobsService],
})
export class PlatformJobsModule {}
