import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaError, PrismaService } from '@/infrastructure';
import { ErrorMessage, SuccessMessage, USER_ROLE_CODE, DeviceInfo } from '@/common';
import { RegisterUserDto } from '../dtos';
import { SessionService } from './session.service';
import { SignupTokenService } from './signup-token.service';
import { LoginResponse } from '../types';
import { Prisma, SocialProvider, UserAccountStatus } from '@prisma/client';

@Injectable()
export class RegisterService {
  constructor(
    private readonly database: PrismaService,
    private readonly sessionService: SessionService,
    private readonly signupTokenService: SignupTokenService,
  ) {}

  async register(dto: RegisterUserDto, deviceInfo: DeviceInfo): Promise<LoginResponse> {
    const { signupToken, firstName, lastName, phoneNumberDiallingCode, phoneNumber, gender } = dto;

    // Verify and decode the signup token — throws if invalid/expired
    const { email, provider, providerId } = await this.signupTokenService.verify(signupToken);

    try {
      // Race condition guard: if user already exists, log them in instead of duplicating
      const existingUser = await this.database.user.findUnique({
        where: { email },
        select: {
          id: true,
          profile: { select: { onboardingCompleted: true, onboardingStep: true } },
        },
      });

      if (existingUser) {
        const { sessionId, tokenPair } = await this.sessionService.createSession({
          userId: existingUser.id,
          deviceInfo,
        });

        return {
          message: SuccessMessage.LOGIN_SUCCESSFUL,
          sessionId,
          accessToken: tokenPair.accessToken,
          refreshToken: tokenPair.refreshToken,
          onboardingCompleted: existingUser.profile?.onboardingCompleted ?? false,
          onboardingStep: existingUser.profile?.onboardingStep ?? 0,
        };
      }

      const isSocial = provider !== 'email';

      const user = await this.database.$transaction(async tx => {
        return tx.user.create({
          data: {
            email,
            firstName,
            lastName,
            status: UserAccountStatus.ACTIVE,
            userAuth: {
              create: { emailVerifiedAt: new Date() },
            },
            userRole: {
              create: { role: { connect: { code: USER_ROLE_CODE } } },
            },
            profile: {
              create: { phoneNumberDiallingCode, phoneNumber, gender },
            },
            ...(isSocial && providerId
              ? {
                  socialAuths: {
                    create: {
                      provider: provider as SocialProvider,
                      providerId,
                    },
                  },
                }
              : {}),
          },
        });
      });

      const { sessionId, tokenPair } = await this.sessionService.createSession({
        userId: user.id,
        deviceInfo,
      });

      return {
        message: SuccessMessage.ACCOUNT_REGISTERED_SUCCESSFULLY,
        sessionId,
        accessToken: tokenPair.accessToken,
        refreshToken: tokenPair.refreshToken,
        onboardingCompleted: false,
        onboardingStep: 0,
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === PrismaError.RequiredRecordNotFound) {
          throw new ConflictException(ErrorMessage.RESOURCE_NOT_FOUND('Role'));
        }
      }

      throw error;
    }
  }
}
