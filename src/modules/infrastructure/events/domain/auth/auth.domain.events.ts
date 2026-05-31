import {
  ACCOUNT_BLOCKED,
  ACCOUNT_CREATED,
  ACCOUNT_VERIFIED,
  USER_FORGOT_PASSWORD,
  USER_LOGIN_OTP,
} from '@/common';
import { Event } from '../../interfaces';

/**
 * The aggregateId is the userId
 */

export class AccountCreatedEvent implements Event {
  readonly eventName = ACCOUNT_CREATED;

  constructor(
    public readonly aggregateId: string,
    public readonly email: string,
    public readonly userName: string,
    public readonly verificationCode: string,
  ) {}
}

export class AccountVerifiedEvent implements Event {
  readonly eventName = ACCOUNT_VERIFIED;

  constructor(
    public readonly aggregateId: string,
    public readonly email: string,
    public readonly userName: string,
  ) {}
}

export class AccountBlockedEvent implements Event {
  readonly eventName = ACCOUNT_BLOCKED;

  constructor(
    public readonly aggregateId: string,
    public readonly email: string,
    public readonly userName: string,
  ) {}
}

export class UserLoginOtpEvent implements Event {
  readonly eventName = USER_LOGIN_OTP;

  constructor(
    public readonly aggregateId: string,
    public readonly email: string,
    public readonly userName: string,
    public readonly loginCode: string,
  ) {}
}

export class UserForgotPasswordEvent implements Event {
  readonly eventName = USER_FORGOT_PASSWORD;

  constructor(
    public readonly aggregateId: string,
    public readonly email: string,
    public readonly userName: string,
    public readonly resetCode: string,
  ) {}
}

export const AuthEvents = [
  AccountCreatedEvent,
  AccountVerifiedEvent,
  AccountBlockedEvent,
  UserForgotPasswordEvent,
  UserLoginOtpEvent,
];
