import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '@/infrastructure';
import { DeviceInfo, SuccessMessage, Util } from '@/common';
import { User } from '@prisma/client';
import { AdminLoginResponse } from '../types';
import { SessionService } from './session.service';
import { AccountSecurityService } from './account-security.service';

@Injectable()
export class LoginService {
  constructor(
    private readonly database: PrismaService,
    private readonly sessionService: SessionService,
    private readonly accountSecurityService: AccountSecurityService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(LoginService.name);
  }

  async validateUser(email: string, password: string) {
    const user = await this.database.user.findUnique({
      where: { email, isStaff: true },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        isStaff: true,
        status: true,
        userAuth: {
          select: {
            password: true,
            emailVerifiedAt: true,
            isBlocked: true,
            failedLoginAttempts: true,
            lastFailedLoginAt: true,
          },
        },
      },
    });

    if (!user || !user.userAuth?.password) return null;

    const isPasswordValid = await Util.validateHash(password, user.userAuth.password);

    if (!isPasswordValid) {
      await this.accountSecurityService.handleFailedLoginAttempt(user.id);

      return null;
    }

    await this.accountSecurityService.resetFailedLoginAttempts(user.id);

    return user;
  }

  async login(user: User, deviceInfo: DeviceInfo, sessionId?: string): Promise<AdminLoginResponse> {
    await this.accountSecurityService.validateUserAccount(user);

    const session = await this.sessionService.createSession({
      deviceInfo,
      userId: user.id,
      sessionId,
    });

    return {
      message: SuccessMessage.LOGIN_SUCCESSFUL,
      sessionId: session.sessionId,
      accessToken: session.tokenPair.accessToken,
      refreshToken: session.tokenPair.refreshToken,
    };
  }
}
