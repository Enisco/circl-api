import { AppHealthModule } from './app-health';
import { EventBusModule } from './events';
import { NotificationModule } from './notification';
import { SchedulerModule } from './scheduler';
import { WorkerModule } from './workers';

export const INFRASTRUCTURE_MODULES = [
  AppHealthModule,
  EventBusModule,
  SchedulerModule,
  WorkerModule,
  NotificationModule,
];
