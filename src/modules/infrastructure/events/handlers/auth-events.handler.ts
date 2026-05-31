import {
  AccountCreatedEvent,
  AccountVerifiedEvent,
  AccountBlockedEvent,
  UserLoginOtpEvent,
  UserForgotPasswordEvent,
} from '@/modules/infrastructure/events';
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PinoLogger } from 'nestjs-pino';
import { NotificationQueue } from '../../workers/queues';
import {
  ACCOUNT_BLOCKED,
  ACCOUNT_CREATED,
  ACCOUNT_VERIFIED,
  USER_LOGIN_OTP,
  NotificationChannel,
  NotificationPriority,
  USER_FORGOT_PASSWORD,
} from '@/common';

@Injectable()
export class AuthEventsHandler {
  constructor(
    private readonly notificationQueue: NotificationQueue,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AuthEventsHandler.name);
  }

  @OnEvent(ACCOUNT_CREATED)
  async handleAccountCreated(event: AccountCreatedEvent) {
    this.logger.info(`Handling ${ACCOUNT_CREATED} event for user ${event.aggregateId}`);

    await this.notificationQueue.addNotification({
      recipient: event.email,
      options: {
        channel: NotificationChannel.EMAIL,
        priority: NotificationPriority.HIGH,
      },
      event,
    });
  }

  @OnEvent(ACCOUNT_VERIFIED)
  async handleAccountVerified(event: AccountVerifiedEvent) {
    this.logger.info(`Handling ${ACCOUNT_VERIFIED} event for user ${event.aggregateId}`);

    await this.notificationQueue.addNotification({
      recipient: event.email,
      options: {
        channel: NotificationChannel.EMAIL,
        priority: NotificationPriority.NORMAL,
      },
      event,
    });
  }

  @OnEvent(USER_LOGIN_OTP)
  async handleUserLoginOtp(event: UserLoginOtpEvent) {
    this.logger.info(`Handling ${USER_LOGIN_OTP} event for user ${event.aggregateId}`);

    await this.notificationQueue.addNotification({
      recipient: event.email,
      options: {
        channel: NotificationChannel.EMAIL,
        priority: NotificationPriority.HIGH,
      },
      event,
    });
  }

  @OnEvent(USER_FORGOT_PASSWORD)
  async handleUserForgotPassword(event: UserForgotPasswordEvent) {
    this.logger.info(`Handling ${USER_FORGOT_PASSWORD} event for user ${event.aggregateId}`);

    await this.notificationQueue.addNotification({
      recipient: event.email,
      options: {
        channel: NotificationChannel.EMAIL,
        priority: NotificationPriority.HIGH,
      },
      event,
    });
  }

  @OnEvent(ACCOUNT_BLOCKED)
  async handleAccountBlocked(event: AccountBlockedEvent) {
    this.logger.info(`Handling ${ACCOUNT_BLOCKED} event for user ${event.aggregateId}`);

    await this.notificationQueue.addNotification({
      recipient: event.email,
      options: {
        channel: NotificationChannel.EMAIL,
        priority: NotificationPriority.HIGH,
      },
      event,
    });
  }
}
