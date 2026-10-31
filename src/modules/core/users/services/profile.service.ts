import {
  ageFromDateOfBirth,
  ApiErrorCode,
  ApiException,
  ErrorMessage,
  SuccessMessage,
  SYSTEM_CONFIG_KEYS,
  toDateOnly,
  toJsonOrUndefined,
} from '@/common';
import { PrismaService } from '@/infrastructure';
import {
  AVATAR_MEDIA_OWNER,
  CityService,
  ContentReviewService,
  ContentSafetyService,
  isCountryCode,
  MediaService,
  NO_COUNTRY,
  SINGLE_IMAGE_RULES,
  SystemConfigService,
  TaxonomyService,
  toCountryCode,
} from '@/modules/platform/shared';
import { Injectable, NotFoundException } from '@nestjs/common';
import {
  ContentScanTrigger,
  ContentVisibilityState,
  ReportTargetType,
  TaxonomyKind,
} from '@prisma/client';
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
    private readonly safety: ContentSafetyService,
    private readonly review: ContentReviewService,
    private readonly config: SystemConfigService,
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
        userAuth: { select: { emailVerifiedAt: true } },
        profile: {
          select: {
            gender: true,
            cityId: true,
            city: { select: { id: true, name: true } },
            countryOfOrigin: true,
            phoneNumberDiallingCode: true,
            phoneNumber: true,
            headline: true,
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

    const { avatarKey, userAuth, ...rest } = user;
    const photoReview = await this.avatarReview(userId, avatarKey);

    return {
      message: 'Profile retrieved successfully',
      data: {
        ...rest,
        // Signed at read time, and falling back to the social provider's URL for a member who never uploaded one of their own (0.11.3).
        avatarUrl: avatarKey ? this.media.sign(avatarKey) : user.profileImageUrl,
        // §6.5: the author is told. A held photo is simply absent everywhere else — which is the
        // whole design, forty read sites need no new rule — so this is the one screen that can
        // say why it went, and the only place it would make sense to ask.
        avatarReview: photoReview,
        /**
         * Whether the address on the account has been confirmed (§13.7, 0.15).
         *
         * Two flows send a code to it and then ask the member to wait: deleting the account and
         * exporting it. An export built for an unconfirmed address still reaches `READY` and no
         * email goes out; a deletion code sent to one is a countdown the member cannot finish.
         * Neither screen could say so, because nothing in any payload said whether the address
         * works — so both pointed at an inbox nothing had been sent to.
         */
        isEmailVerified:
          userAuth?.emailVerifiedAt !== null && userAuth?.emailVerifiedAt !== undefined,
        // Beside the name, exactly as it is on the shared author object (0.9), so the screen that
        // draws your own row does not need a different rule from the one that draws everybody else's.
        countryCode: toCountryCode(profile?.countryOfOrigin),
        profile: profile
          ? {
              ...profile,
              // The same value under the name the **public** profile has always published
              // (`GET /users/:id/profile` → `isOpenToMessages`). Until now your own profile only
              // carried `openInbox`, so a client reading the published name found nothing here and
              // concluded the setting did not exist. Both are returned rather than renaming one,
              // because `openInbox` is in this endpoint's own Swagger examples.
              isOpenToMessages: profile.openInbox,
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

  /**
   * What the member is told about a photo that was taken down (§6.5, §6.1).
   *
   * Only asked when they are wearing nothing: a held avatar has had its key cleared, so "no key"
   * is the only state in which there is anything to explain, and a member who never uploaded one
   * costs a single indexed lookup that finds nothing.
   */
  private async avatarReview(userId: string, avatarKey: string | null) {
    if (avatarKey) return null;

    const held = await this.database.media.findFirst({
      where: {
        ownerType: AVATAR_MEDIA_OWNER,
        ownerId: userId,
        moderationState: { not: ContentVisibilityState.VISIBLE },
      },
      select: { id: true, moderationState: true },
      orderBy: { updatedAt: 'desc' },
    });

    if (!held) return null;

    return this.review.forAuthor(ReportTargetType.MEDIA, held.id, held.moderationState);
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

    await this.assertValidCodes(userId, dto);
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

        if (avatar?.length) {
          await this.media.attach(tx, avatar, AVATAR_MEDIA_OWNER, userId);

          // §6.1 scans avatars. On its own target, not as part of the profile's text scan: a
          // photo nobody should see is no reason to hold a paragraph that is fine, and the
          // verdict has somewhere of its own to go (`media.moderationState`, §4.5). A held
          // avatar clears `avatarKey`, which is the one effect forty read sites already handle.
          await this.safety.assess(tx, {
            targetType: ReportTargetType.MEDIA,
            targetId: avatar[0].id,
            authorId: userId,
            // Nothing for a lexicon to read, which is why an avatar's verdict is the
            // classifier's alone — and why this scan concludes nothing while it is switched off.
            fields: {},
            mediaKeys: [avatar[0].storageKey],
            trigger: ContentScanTrigger.CREATE,
            summary: 'Profile photo',
          });
        }
      }

      // §6.1 scans the written part of a profile: the headline, the bio and what somebody says
      // they can help with. Held with `bioVisibilityState` rather than the row's own state, so a
      // paragraph under review does not make the member disappear (§4.5).
      const saved = await tx.userProfile.findUnique({
        where: { userId },
        select: { id: true, headline: true, bio: true, canHelpWith: true },
      });

      if (saved) {
        await this.safety.assess(tx, {
          targetType: ReportTargetType.USER_PROFILE,
          targetId: saved.id,
          authorId: userId,
          fields: {
            headline: saved.headline,
            bio: saved.bio,
            canHelpWith: saved.canHelpWith,
          },
          trigger: ContentScanTrigger.EDIT,
          summary: saved.headline,
        });
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
      headline,
      bio,
      canHelpWith,
      openInbox,
      isOpenToMessages,
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
      ...(headline !== undefined && { headline }),
      ...(bio !== undefined && { bio }),
      ...(canHelpWith !== undefined && { canHelpWith }),
      // One field, either name. `isOpenToMessages` is what the read endpoints publish and wins when
      // both arrive; `openInbox` is the older name and keeps working.
      ...(isOpenToMessages !== undefined
        ? { openInbox: isOpenToMessages }
        : openInbox !== undefined
          ? { openInbox }
          : {}),
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

  /** The taxonomy codes this member already carries, per field. */
  private async heldCodes(userId: string): Promise<{
    interests: ReadonlySet<string>;
    languages: ReadonlySet<string>;
    heritageTag: ReadonlySet<string>;
    journeyStage: ReadonlySet<string>;
  }> {
    const profile = await this.database.userProfile.findUnique({
      where: { userId },
      select: { interests: true, languages: true, heritageTag: true, journeyStage: true },
    });

    const list = (value: unknown): ReadonlySet<string> =>
      new Set(Array.isArray(value) ? (value as string[]) : []);
    const one = (value: string | null): ReadonlySet<string> => new Set(value ? [value] : []);

    return {
      interests: list(profile?.interests),
      languages: list(profile?.languages),
      heritageTag: one(profile?.heritageTag ?? null),
      journeyStage: one(profile?.journeyStage ?? null),
    };
  }

  /** Every enumerated value is a code from the taxonomy, so an unknown one is rejected here rather than stored and rendered as a raw code later (0.7). */
  private async assertValidCodes(userId: string, dto: UpdateProfileDto): Promise<void> {
    // What they hold now. A term retired since they chose it stays writable by them, so editing a
    // bio is not refused over a picker that has moved on.
    const held = await this.heldCodes(userId);

    if (dto.interests?.length) {
      // The cap, as a refusal that carries the limit rather than a validator complaining about an
      // array length — the same shape the Connect write and the staff edit use, because the app
      // renders `data.limit` and cannot render a class-validator message.
      //
      // Read from configuration: `taxonomy.limits.maxInterests` is what the app was told, so a
      // number compiled in here would be a second rule that could disagree with it.
      const maxInterests = await this.config.get(SYSTEM_CONFIG_KEYS.MAX_INTERESTS);

      if (dto.interests.length > maxInterests) {
        throw ApiException.unprocessable(
          ApiErrorCode.VALIDATION_FAILED,
          `Pick up to ${maxInterests} interests.`,
          {
            data: { limit: maxInterests, sent: dto.interests.length },
            details: [{ field: 'interests', message: `Up to ${maxInterests}.` }],
          },
        );
      }

      await this.taxonomy.assertAllValid(
        TaxonomyKind.INTEREST,
        dto.interests,
        'interests',
        held.interests,
      );
    }

    if (dto.languages?.length) {
      await this.taxonomy.assertAllValid(
        TaxonomyKind.LANGUAGE,
        dto.languages,
        'languages',
        held.languages,
      );
    }

    if (dto.heritageTag) {
      await this.taxonomy.assertValid(
        TaxonomyKind.HERITAGE_TAG,
        dto.heritageTag,
        'heritageTag',
        held.heritageTag,
      );
    }

    if (dto.journeyStage) {
      await this.taxonomy.assertValid(
        TaxonomyKind.JOURNEY_STAGE,
        dto.journeyStage,
        'journeyStage',
        held.journeyStage,
      );
    }

    // Countries come from ICU rather than a vocabulary we maintain, so this checks the code is a
    // real one rather than that it is on a list somebody remembered to extend. `OTHER` is the
    // member who would rather not say.
    if (dto.countryOfOrigin && dto.countryOfOrigin !== NO_COUNTRY) {
      if (!isCountryCode(dto.countryOfOrigin)) {
        throw ApiException.unprocessable(
          ApiErrorCode.VALIDATION_FAILED,
          `"${dto.countryOfOrigin}" is not a country code. Send ISO 3166-1 alpha-2, or OTHER.`,
          {
            details: [
              { field: 'countryOfOrigin', message: 'Expected an ISO 3166-1 alpha-2 code.' },
            ],
          },
        );
      }
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
