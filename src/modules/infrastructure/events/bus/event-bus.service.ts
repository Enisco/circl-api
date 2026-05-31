import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Event } from '../interfaces';
import { PinoLogger } from 'nestjs-pino';

@Injectable()
export class EventBusService {
  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(EventBusService.name);
  }

  publish<T extends Event>(event: T): void {
    this.logger.info(`Publishing event: ${event.eventName} for ${event.aggregateId}`);

    const enrichedEvent = {
      ...event,
      timestamp: event.timestamp || Date.now(),
    };

    this.eventEmitter.emit(event.eventName, enrichedEvent);
  }

  publishAll(events: Event[]): void {
    events.forEach(event => this.publish(event));
  }

  subscribe<T extends Event>(
    eventName: string | symbol | (string | symbol)[],
    handler: (event: T) => void | Promise<void>,
  ): void {
    this.eventEmitter.on(eventName, handler);
  }

  subscribeOnce<T extends Event>(
    eventName: string | symbol | (string | symbol)[],
    handler: (event: T) => void | Promise<void>,
  ): void {
    this.eventEmitter.once(eventName, handler);
  }

  unsubscribe(
    eventName: string | symbol | (string | symbol)[],
    handler?: (...args: any[]) => void,
  ): void {
    this.eventEmitter.off(eventName, handler);
  }
}
