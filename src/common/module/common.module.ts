import { Module } from '@nestjs/common';
import { DeviceService } from './services';

@Module({
  providers: [DeviceService],
  exports: [DeviceService],
})
export class CommonModule {}
