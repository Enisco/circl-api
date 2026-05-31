import { PrismaService } from '@/infrastructure';
import { AccountBlockedEvent, EventBusService } from '@/modules/infrastructure/events';
import { ForbiddenException, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { VerificationEventService } from './verification-event.service';
import { AUTH_CONSTANTS } from '../constants';
import { AuthErrorType, ErrorMessage } from '@/common';
import { User, UserAccountStatus, UserAuth } from '@prisma/client';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AccountSecurityService {
  constructor(
    private readonly config: ConfigService,
    private readonly database: PrismaService,
    private readonly logger: PinoLogger,
    private readonly eventBus: EventBusService,
    private readonly verificationEventService: VerificationEventService,
  ) {
    this.logger.setContext(AccountSecurityService.name);
  }

  async handleFailedLoginAttempt(userId: string): Promise<void> {
    const updatedUserAuth = await this.database.userAuth.update({
      where: { userId },
      data: {
        failedLoginAttempts: { increment: 1 },
        lastFailedLoginAt: new Date(),
      },
    });

    if (updatedUserAuth.failedLoginAttempts >= AUTH_CONSTANTS.MAX_LOGIN_ATTEMPTS) {
      await this.blockUserAccount(userId);
      throw new ForbiddenException({
        statusCode: 403,
        errorType: AuthErrorType.ACCOUNT_BLOCKED,
        message: ErrorMessage.ACCOUNT_BLOCKED,
      });
    }
  }

  async blockUserAccount(userId: string) {
    const userAuth = await this.database.userAuth.update({
      where: { userId },
      data: { isBlocked: true },
      include: { user: { select: { id: true, firstName: true, email: true } } },
    });

    this.eventBus.publish(
      new AccountBlockedEvent(userAuth.user.id, userAuth.user.email, userAuth.user.firstName),
    );
  }

  async checkAndResolveBlockStatus(lastFailedLoginAt: Date): Promise<void> {
    const lockDurationMs = AUTH_CONSTANTS.MAX_LOCK_TIME * 60 * 1000;
    const elapsed = lastFailedLoginAt ? Date.now() - lastFailedLoginAt.getTime() : lockDurationMs;

    if (elapsed >= lockDurationMs) {
      return;
    }

    const remainingMinutes = Math.ceil((lockDurationMs - elapsed) / 60_000);

    throw new ForbiddenException({
      statusCode: 403,
      errorType: AuthErrorType.ACCOUNT_LOCKED,
      message: `Your account is temporarily locked. Try again in ${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'}.`,
    });
  }

  async resetFailedLoginAttempts(userId: string) {
    await this.database.userAuth.update({
      where: { userId },
      data: {
        failedLoginAttempts: 0,
        isBlocked: false,
        lastFailedLoginAt: null,
        lastLoginAt: new Date(),
      },
    });
  }

  async validateUserAccount(
    user: Pick<User, 'id' | 'email' | 'firstName' | 'status'> & {
      userAuth: Pick<
        UserAuth,
        'emailVerifiedAt' | 'isBlocked' | 'failedLoginAttempts' | 'lastFailedLoginAt'
      > | null;
    },
  ) {
    if (!user.userAuth?.emailVerifiedAt) {
      await this.verificationEventService.sendVerificationOtp(user.email, user.firstName);
      throw new ForbiddenException({
        statusCode: 403,
        errorType: AuthErrorType.UNVERIFIED_EMAIL,
        message: ErrorMessage.EMAIL_NOT_VERIFIED,
      });
    }

    if (user.status === UserAccountStatus.SUSPENDED) {
      throw new ForbiddenException({
        statusCode: 403,
        errorType: AuthErrorType.ACCOUNT_DISABLED,
        message: `${ErrorMessage.ACCESS_DENIED}. Please, contact support at ${this.config.get<string>('SUPPORT_EMAIL')} for assistance.`,
      });
    }

    if (user.userAuth?.isBlocked) {
      await this.checkAndResolveBlockStatus(user.userAuth.lastFailedLoginAt);
    }
  }
}
