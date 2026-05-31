import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '@/infrastructure';
import { AccountBlockedEvent, EventBusService } from '@/modules/infrastructure/events';
import { AuthErrorType, ErrorMessage } from '@/common';
import { User, UserAccountStatus } from '@prisma/client';
import { AUTH_CONSTANTS } from '../constants';

@Injectable()
export class AccountSecurityService {
  constructor(
    private readonly configService: ConfigService,
    private readonly database: PrismaService,
    private readonly logger: PinoLogger,
    private readonly eventBus: EventBusService,
  ) {
    this.logger.setContext(AccountSecurityService.name);
  }

  async handleFailedLoginAttempt(userId: string): Promise<void> {
    const updated = await this.database.userAuth.update({
      where: { userId },
      data: { failedLoginAttempts: { increment: 1 }, lastFailedLoginAt: new Date() },
    });

    if (updated.failedLoginAttempts >= AUTH_CONSTANTS.MAX_LOGIN_ATTEMPTS) {
      await this.blockUserAccount(userId);
      throw new ForbiddenException(ErrorMessage.ACCOUNT_BLOCKED);
    }
  }

  async blockUserAccount(userId: string): Promise<void> {
    const userAuth = await this.database.userAuth.update({
      where: { userId },
      data: { isBlocked: true },
      select: { isBlocked: true, user: { select: { id: true, firstName: true, email: true } } },
    });

    this.eventBus.publish(
      new AccountBlockedEvent(userAuth.user.id, userAuth.user.email, userAuth.user.firstName),
    );
  }

  async checkAndResolveBlockStatus(userId: string): Promise<void> {
    const userAuth = await this.database.userAuth.findUnique({
      where: { userId },
      select: { isBlocked: true, lastFailedLoginAt: true },
    });

    if (!userAuth?.isBlocked) return;

    const lockMs = AUTH_CONSTANTS.MAX_LOCK_TIME * 60 * 1000;
    const elapsed = userAuth.lastFailedLoginAt
      ? Date.now() - userAuth.lastFailedLoginAt.getTime()
      : lockMs;

    if (elapsed >= lockMs) return;

    const remainingMinutes = Math.ceil((lockMs - elapsed) / 60_000);

    throw new ForbiddenException(
      `Account temporarily locked. Try again in ${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'}.`,
    );
  }

  async resetFailedLoginAttempts(userId: string): Promise<void> {
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

  async validateUserAccount(user: User & { userAuth?: any }): Promise<void> {
    if (!user.userAuth?.emailVerifiedAt) {
      throw new ForbiddenException({
        statusCode: 403,
        errorType: AuthErrorType.UNVERIFIED_EMAIL,
        message: ErrorMessage.EMAIL_NOT_VERIFIED,
      });
    }

    if (user.status !== UserAccountStatus.ACTIVE) {
      throw new ForbiddenException({
        statusCode: 403,
        errorType: AuthErrorType.ACCOUNT_DISABLED,
        message: `${ErrorMessage.ACCESS_DENIED}. Contact support for assistance.`,
      });
    }

    await this.checkAndResolveBlockStatus(user.id);
  }
}
