import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { GuardController } from './controllers/guard.controller';
import { GuardCoreModule } from './guard-core.module';

@Module({
  imports: [
    GuardCoreModule,
    RouterModule.register([
      { path: 'api/v1', module: CirclGuardModule, children: [GuardController] },
    ]),
  ],
  controllers: [GuardController],
  // The service comes from `GuardCoreModule`, which has no routes of its own — see the comment
  // there. Re-exported so importers of this module keep working unchanged.
  exports: [GuardCoreModule],
})
export class CirclGuardModule {}
