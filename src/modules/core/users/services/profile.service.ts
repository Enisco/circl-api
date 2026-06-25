import { ErrorMessage, SuccessMessage } from '@/common';
import { PrismaService } from '@/infrastructure';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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
        username: true,
        profileImageUrl: true,
        email: true,
        createdAt: true,
        profile: {
          select: {
            gender: true,
            cityId: true,
            city: { select: { id: true, name: true } },
            countryOfOrigin: true,
            phoneNumberDiallingCode: true,
            phoneNumber: true,
            bio: true,
            canHelpWith: true,
            openInbox: true,
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
    const { firstName, lastName, profileImageUrl, username } = dto;

    if (username !== undefined) {
      const taken = await this.database.user.findFirst({
        where: { username, NOT: { id: userId } },
        select: { id: true },
      });

      if (taken) throw new ConflictException('Username is already taken');
    }

    await this.database.$transaction(async tx => {
      const userUpdate: Record<string, unknown> = {};

      if (firstName !== undefined) userUpdate.firstName = firstName;
      if (lastName !== undefined) userUpdate.lastName = lastName;
      if (profileImageUrl !== undefined) userUpdate.profileImageUrl = profileImageUrl;
      if (username !== undefined) userUpdate.username = username;

      if (Object.keys(userUpdate).length > 0) {
        await tx.user.update({ where: { id: userId }, data: userUpdate });
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
      cityId,
      countryOfOrigin,
      bio,
      canHelpWith,
      openInbox,
      onboardingCompleted,
      onboardingStep,
    } = dto;

    return {
      ...(phoneNumberDiallingCode !== undefined && { phoneNumberDiallingCode }),
      ...(phoneNumber !== undefined && { phoneNumber }),
      ...(gender !== undefined && { gender }),
      ...(cityId !== undefined && { cityId }),
      ...(countryOfOrigin !== undefined && { countryOfOrigin }),
      ...(bio !== undefined && { bio }),
      ...(canHelpWith !== undefined && { canHelpWith }),
      ...(openInbox !== undefined && { openInbox }),
      ...(onboardingCompleted !== undefined && { onboardingCompleted }),
      ...(onboardingStep !== undefined && { onboardingStep }),
    };
  }
}
