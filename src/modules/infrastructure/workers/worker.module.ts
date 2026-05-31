import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QUEUES } from '@/common';
import { NotificationModule } from '@/modules/infrastructure/notification';
import { DomainProcessors } from './processors';
import { DomainQueues } from './queues';

const bullQueues = Object.values(QUEUES).map(name => ({ name }));

@Module({
  imports: [NotificationModule, ...bullQueues.map(queue => BullModule.registerQueue(queue))],
  providers: [...DomainQueues, ...DomainProcessors],
})
export class WorkerModule {}
