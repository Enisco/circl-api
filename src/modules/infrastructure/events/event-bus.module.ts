import { Module, Global } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { DomainEvents } from './domain';
import { DomainEventHandlers } from './handlers';
import { EventBusService } from './bus';
import { NotificationModule } from '@/modules/infrastructure/notification';

@Global()
@Module({
  imports: [
    EventEmitterModule.forRoot({
      wildcard: true,
      delimiter: '.',
      maxListeners: 20,
    }),
    NotificationModule,
  ],
  providers: [EventBusService, ...DomainEvents, ...DomainEventHandlers],
  exports: [EventBusService],
})
export class EventBusModule {}
