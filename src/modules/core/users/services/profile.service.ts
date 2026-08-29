import {
  ageFromDateOfBirth,
  ApiErrorCode,
  ApiException,
  ErrorMessage,
  SuccessMessage,
  toDateOnly,
  toJsonOrUndefined,
} from '@/common';
import { PrismaService } from '@/infrastructure';
import {
  AVATAR_MEDIA_OWNER,
  CityService,
  MediaService,
  SINGLE_IMAGE_RULES,
  TaxonomyService,
} from '@/modules/platform';
import { Injectable, NotFoundException } from '@nestjs/common';
import { TaxonomyKind } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { UpdateProfileDto } from '../dtos';

@Injectable()
export class ProfileService {
  constructor(
    private readonly logger: PinoLogger,
    private readonly database: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly cities: CityService,
    private readonly media: MediaService,
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
        avatarKey: true,
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
            dateOfBirth: true,
            interests: true,
            languages: true,
            heritageTag: true,
            journeyStage: true,
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException(ErrorMessage.RESOURCE_NOT_FOUND('user'));
    }

    const profile = user.profile;

    const { avatarKey, ...rest } = user;

    return {
      message: 'Profile retrieved successfully',
      data: {
        ...rest,
        // Signed at read time, and falling back to the social provider's URL for a member who never uploaded one of their own (0.11.3).
        avatarUrl: avatarKey ? this.media.sign(avatarKey) : user.profileImageUrl,
        profile: profile
          ? {
              ...profile,
              dateOfBirth: toDateOnly(profile.dateOfBirth),
              // Derived, never stored as a number: a number cannot be re-validated later, and someone who typed 18 last year is still 18 forever (3.1.2).
              age: ageFromDateOfBirth(profile.dateOfBirth),
              dateOfBirthLocked: profile.dateOfBirth !== null,
              interests: (profile.interests as string[] | null) ?? [],
              languages: (profile.languages as string[] | null) ?? [],
            }
          : null,
      },
    };
  }

  async checkUsername(username: string) {
    const existing = await this.database.user.findFirst({
      where: { username },
      select: { id: true },
    });

    return {
      message: existing ? 'Username is already taken' : 'Username is available',
      data: { available: !existing },
    };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const { firstName, lastName, avatarKey, username } = dto;

    await this.assertValidCodes(dto);
    await this.assertDateOfBirthWritable(userId, dto);

    // Written straight into a foreign key, so an unknown city has to be caught here rather than surfacing as a constraint violation.
    const city = dto.cityId ? await this.cities.assertValid(dto.cityId) : null;

    // An avatar key is somebody's claim about an object they uploaded, so it is checked the same way every other attachment is (0.11.2): it must exist, be theirs, and not already belong to another record.
    const avatar =
      avatarKey === undefined || avatarKey === null
        ? null
        : await this.media.validate([avatarKey], userId, SINGLE_IMAGE_RULES, 'avatarKey');

    if (username !== undefined) {
      const taken = await this.database.user.findFirst({
        where: { username, NOT: { id: userId } },
        select: { id: true },
      });

      if (taken) {
        throw ApiException.conflict(
          ApiErrorCode.USERNAME_TAKEN,
          'That username is already taken.',
          { details: [{ field: 'username', message: 'That username is already taken.' }] },
        );
      }
    }

    await this.database.$transaction(async tx => {
      const userUpdate: Record<string, unknown> = {};

      if (firstName !== undefined) userUpdate.firstName = firstName;
      // Null is a value here, not an absence: a member with a one-word name clears it (0.16.2).
      if (lastName !== undefined) userUpdate.lastName = lastName || null;
      if (username !== undefined) userUpdate.username = username;

      // `undefined` leaves the photo alone; an explicit `null` clears it back to initials.
      if (avatarKey !== undefined) {
        userUpdate.avatarKey = avatarKey === null ? null : avatar![0].storageKey;
      }

      if (Object.keys(userUpdate).length > 0) {
        await tx.user.update({ where: { id: userId }, data: userUpdate });
      }

      const profileData = this.mapProfileUpdate(dto, city?.id);

      await tx.userProfile.upsert({
        where: { userId },
        update: profileData,
        create: { userId, ...profileData },
      });

      if (avatarKey !== undefined) {
        // The previous avatar is released whether it is being replaced or cleared, otherwise it stays ATTACHED forever and the orphan sweep, which only collects unattached objects, never reaches it.
        await this.media.releaseOwner(tx, AVATAR_MEDIA_OWNER, userId);

        if (avatar?.length) await this.media.attach(tx, avatar, AVATAR_MEDIA_OWNER, userId);
      }
    });

    // The updated record comes back rather than a null, so Edit Profile renders the result it just saved instead of refetching (0.16.2).
    const updated = await this.getProfile(userId);

    return {
      message: SuccessMessage.PROFILE_UPDATED_SUCCESSFULLY,
      data: updated.data,
    };
  }

  private mapProfileUpdate(dto: UpdateProfileDto, resolvedCityId?: string) {
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
      dateOfBirth,
      interests,
      languages,
      heritageTag,
      journeyStage,
    } = dto;

    return {
      ...(phoneNumberDiallingCode !== undefined && { phoneNumberDiallingCode }),
      ...(phoneNumber !== undefined && { phoneNumber }),
      ...(gender !== undefined && { gender }),
      ...(cityId !== undefined && { cityId: resolvedCityId ?? cityId }),
      ...(countryOfOrigin !== undefined && { countryOfOrigin }),
      ...(bio !== undefined && { bio }),
      ...(canHelpWith !== undefined && { canHelpWith }),
      ...(openInbox !== undefined && { openInbox }),
      ...(onboardingCompleted !== undefined && { onboardingCompleted }),
      ...(onboardingStep !== undefined && { onboardingStep }),
      ...(dateOfBirth !== undefined && {
        dateOfBirth: new Date(`${dateOfBirth.slice(0, 10)}T00:00:00.000Z`),
        dateOfBirthSetAt: new Date(),
      }),
      ...(interests !== undefined && { interests: toJsonOrUndefined(interests) }),
      ...(languages !== undefined && { languages: toJsonOrUndefined(languages) }),
      ...(heritageTag !== undefined && { heritageTag }),
      ...(journeyStage !== undefined && { journeyStage }),
    };
  }

  /** Every enumerated value is a code from the taxonomy, so an unknown one is rejected here rather than stored and rendered as a raw code later (0.7). */
  private async assertValidCodes(dto: UpdateProfileDto): Promise<void> {
    if (dto.interests?.length) {
      await this.taxonomy.assertAllValid(TaxonomyKind.INTEREST, dto.interests, 'interests');
    }

    if (dto.languages?.length) {
      await this.taxonomy.assertAllValid(TaxonomyKind.LANGUAGE, dto.languages, 'languages');
    }

    if (dto.heritageTag) {
      await this.taxonomy.assertValid(TaxonomyKind.HERITAGE_TAG, dto.heritageTag, 'heritageTag');
    }

    if (dto.journeyStage) {
      await this.taxonomy.assertValid(TaxonomyKind.JOURNEY_STAGE, dto.journeyStage, 'journeyStage');
    }

    if (dto.countryOfOrigin) {
      await this.taxonomy.assertValid(
        TaxonomyKind.COUNTRY_OF_ORIGIN,
        dto.countryOfOrigin,
        'countryOfOrigin',
      );
    }
  }

  /** D10 and 3.1.2: date of birth is collected once and then locked, because it is an age gate. */
  private async assertDateOfBirthWritable(userId: string, dto: UpdateProfileDto): Promise<void> {
    if (dto.dateOfBirth === undefined) return;

    const profile = await this.database.userProfile.findUnique({
      where: { userId },
      select: { dateOfBirth: true },
    });

    if (profile?.dateOfBirth) {
      throw ApiException.forbidden(
        ApiErrorCode.DOB_LOCKED,
        'Your date of birth is already set. Contact support if it needs to change.',
        {
          details: [
            { field: 'dateOfBirth', message: 'Already set. Contact support to change it.' },
          ],
        },
      );
    }

    const age = ageFromDateOfBirth(new Date(`${dto.dateOfBirth.slice(0, 10)}T00:00:00.000Z`));

    if (age === null || age < 13) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'Please enter a valid date of birth.',
        { details: [{ field: 'dateOfBirth', message: 'Please enter a valid date of birth.' }] },
      );
    }
  }
}
