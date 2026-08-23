import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { GuardController } from './controllers/guard.controller';
import { GuardService } from './services/guard.service';

@Module({
  imports: [
    RouterModule.register([{ path: 'api/v1', module: CirclGuardModule, children: [GuardController] }]),
  ],
  controllers: [GuardController],
  providers: [GuardService],
  exports: [GuardService],
})
export class CirclGuardModule {}
