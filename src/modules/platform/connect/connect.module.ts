import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { ConnectController } from './controllers/connect.controller';
import { ConnectProfileService } from './services/connect-profile.service';
import { ConnectionRequestService } from './services/connection-request.service';
import { DiscoveryService } from './services/discovery.service';

@Module({
  imports: [
    RouterModule.register([{ path: 'api/v1', module: ConnectModule, children: [ConnectController] }]),
  ],
  controllers: [ConnectController],
  providers: [ConnectProfileService, DiscoveryService, ConnectionRequestService],
  exports: [ConnectProfileService],
})
export class ConnectModule {}
