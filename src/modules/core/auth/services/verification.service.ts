import { BadRequestException, Injectable } from '@nestjs/common';
import { DeviceInfo, ErrorMessage, SuccessMessage, Util } from '@/common';
import { PinoLogger } from 'nestjs-pino';
import { SendVerificationTokenDto, VerifyEmailDto } from '../dtos';
import { EventBusService } from '@/modules/infrastructure/events';
import { CacheService, PrismaService } from '@/infrastructure';
import { LoginResponse, VerificationResponse, VerifyOtpResponse } from '../types';
import { SessionService } from './session.service';
import { VerificationEventService, OTP_CACHE_KEY } from './verification-event.service';
import { SignupTokenService } from './signup-token.service';
import { AccountSecurityService } from './account-security.service';

@Injectable()
export class VerificationService {
  constructor(
    private readonly logger: PinoLogger,
    private readonly cache: CacheService,
    private readonly database: PrismaService,
    private readonly verificationEventService: VerificationEventService,
    private readonly sessionService: SessionService,
    private readonly signupTokenService: SignupTokenService,
    private readonly accountSecurityService: AccountSecurityService,
    protected readonly eventBus: EventBusService,
  ) {
    this.logger.setContext(VerificationService.name);
  }

  private async validateOtp(email: string, inputCode: string): Promise<boolean> {
    const cachedHashedCode = await this.cache.get<string>(OTP_CACHE_KEY(email));

    if (!cachedHashedCode) return false;

    return Util.validateHash(inputCode, cachedHashedCode);
  }

  private async deleteOtp(email: string) {
    await this.cache.delete(OTP_CACHE_KEY(email));
  }

  async sendVerifyAccountToken(dto: SendVerificationTokenDto): Promise<VerificationResponse> {
    const { email } = dto;

    const user = await this.database.user.findUnique({
      where: { email },
      select: { firstName: true },
    });

    await this.verificationEventService.sendVerificationOtp(email, user?.firstName);

    return {
      success: true,
      message: SuccessMessage.VERIFICATION_EMAIL_SENT,
    };
  }

  async verifyAccount(dto: VerifyEmailDto, deviceInfo: DeviceInfo): Promise<VerifyOtpResponse> {
    const { email, code } = dto;

    const isCodeValid = await this.validateOtp(email, code);

    if (!isCodeValid) {
      const existingUser = await this.database.user.findUnique({
        where: { email },
        select: { id: true },
      });

      if (existingUser) {
        await this.accountSecurityService.handleFailedLoginAttempt(existingUser.id);
      }

      throw new BadRequestException(ErrorMessage.INVALID_VERIFICATION_CODE);
    }

    await this.deleteOtp(email);

    const user = await this.database.user.findUnique({
      where: { email },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        status: true,
        userAuth: {
          select: {
            emailVerifiedAt: true,
            isBlocked: true,
            failedLoginAttempts: true,
            lastFailedLoginAt: true,
          },
        },
        profile: { select: { onboardingCompleted: true, onboardingStep: true } },
      },
    });

    // New user — return a signup token so they can proceed to create their account
    if (!user) {
      const signupToken = await this.signupTokenService.sign({ email, provider: 'email' });

      return { isNewUser: true, signupToken };
    }

    // Existing user — validate account status before issuing session
    await this.accountSecurityService.validateUserAccount(user);

    if (!user.userAuth?.emailVerifiedAt) {
      await this.database.user.update({
        where: { email },
        data: { userAuth: { update: { emailVerifiedAt: new Date() } } },
      });
    }

    const { sessionId, tokenPair } = await this.sessionService.createSession({
      userId: user.id,
      deviceInfo,
    });

    await this.accountSecurityService.resetFailedLoginAttempts(user.id);

    return {
      message: SuccessMessage.EMAIL_VERIFIED_SUCCESSFULLY,
      sessionId,
      accessToken: tokenPair.accessToken,
      refreshToken: tokenPair.refreshToken,
      onboardingCompleted: user.profile?.onboardingCompleted ?? false,
      onboardingStep: user.profile?.onboardingStep ?? 0,
    } as LoginResponse;
  }
}
