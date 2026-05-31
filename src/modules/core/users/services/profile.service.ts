import { ErrorMessage, SuccessMessage } from '@/common';
import { PrismaService } from '@/infrastructure';
import { Injectable, NotFoundException } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { UpdateProfileDto } from '../dtos';

@Injectable()
export class ProfileService {
  constructor(
    private readonly logger: PinoLogger,
    private readonly database: PrismaService,
  ) {
    this.logger.setContext(ProfileService.name);
  }

  async getProfile(userId: string) {
    const user = await this.database.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        profileImageUrl: true,
        email: true,
        createdAt: true,
        profile: {
          select: {
            phoneNumberDiallingCode: true,
            phoneNumber: true,
            gender: true,
            dateOfBirth: true,
            unitPreference: true,
            onboardingStep: true,
            onboardingCompleted: true,
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException(ErrorMessage.RESOURCE_NOT_FOUND('user'));
    }

    return { message: 'Profile retrieved successfully', data: user };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const { firstName, lastName, profileImageUrl } = dto;

    await this.database.$transaction(async tx => {
      if (firstName !== undefined || lastName !== undefined || profileImageUrl !== undefined) {
        await tx.user.update({
          where: { id: userId },
          data: {
            ...(firstName !== undefined && { firstName }),
            ...(lastName !== undefined && { lastName }),
            ...(profileImageUrl !== undefined && { profileImageUrl }),
          },
        });
      }

      const profileData = this.mapProfileUpdate(dto);

      await tx.userProfile.upsert({
        where: { userId },
        update: profileData,
        create: { userId, ...profileData },
      });
    });

    return {
      message: SuccessMessage.PROFILE_UPDATED_SUCCESSFULLY,
      data: null,
    };
  }

  private mapProfileUpdate(dto: UpdateProfileDto) {
    const {
      phoneNumberDiallingCode,
      phoneNumber,
      gender,
      dateOfBirth,
      unitPreference,
      onboardingCompleted,
      onboardingStep,
    } = dto;

    return {
      ...(phoneNumberDiallingCode !== undefined && { phoneNumberDiallingCode }),
      ...(phoneNumber !== undefined && { phoneNumber }),
      ...(gender !== undefined && { gender }),
      ...(dateOfBirth !== undefined && { dateOfBirth: new Date(dateOfBirth) }),
      ...(unitPreference !== undefined && { unitPreference }),
      ...(onboardingCompleted !== undefined && { onboardingCompleted }),
      ...(onboardingStep !== undefined && { onboardingStep }),
    };
  }
}
