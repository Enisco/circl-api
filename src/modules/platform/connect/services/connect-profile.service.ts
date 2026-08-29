import { Injectable } from '@nestjs/common';
import { ConnectProfile, DmPolicy, Prisma, TaxonomyKind, TrustCheckType } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import {
  ageFromDateOfBirth,
  ApiErrorCode,
  ApiException,
  toDateOnly,
  toJsonOrUndefined,
} from '@/common';
import {
  AuthorView,
  CityService,
  MediaService,
  TaxonomyService,
  TermView,
  authorSelect,
  displayNameOf,
  toAuthorView,
  toCityView,
  toTermView,
} from '../../shared';
import { CONNECT_MINIMUM_AGE } from '../../taxonomy/services/taxonomy-catalogue.service';
import { UpsertConnectProfileDto } from '../dtos/connect.dto';

export interface ConnectProfileView {
  id: string;
  user: AuthorView;
  age: number | null;
  type: TermView | null;
  lookingFor: string;
  languages: TermView[];
  interests: TermView[];
  heritageTag: TermView | null;
  journeyStage: TermView | null;
  /** On the USER record, not on the Connect profile (D15). */
  countryOfOrigin: TermView | null;
  city: ReturnType<typeof toCityView>;
  dmPolicy: DmPolicy;
  isVerified: boolean;
  isVisible: boolean;
}

const profileInclude = {
  user: {
    select: {
      ...authorSelect,
      profile: {
        select: {
          city: { select: { id: true, name: true, region: true } },
          dateOfBirth: true,
          interests: true,
          languages: true,
          heritageTag: true,
          journeyStage: true,
          countryOfOrigin: true,
        },
      },
    },
  },
  city: { select: { id: true, name: true, region: true } },
} satisfies Prisma.ConnectProfileInclude;

type ConnectProfileRow = Prisma.ConnectProfileGetPayload<{ include: typeof profileInclude }>;

@Injectable()
export class ConnectProfileService {
  constructor(
    private readonly database: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly cities: CityService,
    private readonly media: MediaService,
  ) {}

  // ─── 3.2.2 Setup prefill ───────────────────────────────────────────────────

  /** Everything the setup form should already know (3.1). */
  async setupPrefill(userId: string) {
    const [user, profile] = await Promise.all([
      this.database.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          firstName: true,
          lastName: true,
          avatarKey: true,
          profileImageUrl: true,
          profile: {
            select: {
              cityId: true,
              city: { select: { id: true, name: true, region: true } },
              dateOfBirth: true,
              interests: true,
              languages: true,
              heritageTag: true,
              journeyStage: true,
            },
          },
          trustChecks: { where: { status: 'VERIFIED', check: TrustCheckType.IDENTITY } },
        },
      }),
      this.database.connectProfile.findUnique({ where: { userId }, include: profileInclude }),
    ]);

    const dateOfBirth = user.profile?.dateOfBirth ?? null;

    // The fields the form must collect.
    const asks = ['TYPE', 'LOOKING_FOR', 'DM_POLICY', 'VISIBILITY'];

    if (!dateOfBirth) asks.push('DATE_OF_BIRTH');

    return {
      profile: profile ? await this.toView(profile) : null,
      prefill: {
        displayName: displayNameOf(user.firstName, user.lastName),
        avatarUrl: user.avatarKey ? this.media.sign(user.avatarKey) : user.profileImageUrl,
        cityId: user.profile?.cityId ?? null,
        cityName: user.profile?.city?.name ?? null,
        dateOfBirth: toDateOnly(dateOfBirth),
        age: ageFromDateOfBirth(dateOfBirth),
        dateOfBirthLocked: dateOfBirth !== null,
        interests: (user.profile?.interests as string[] | null) ?? [],
        languages: (user.profile?.languages as string[] | null) ?? [],
        heritageTag: user.profile?.heritageTag ?? null,
        journeyStage: user.profile?.journeyStage ?? null,
        isVerified: user.trustChecks.length > 0,
      },
      asks,
      // Sent, not hardcoded, so the gate can change without a release.
      minimumAge: CONNECT_MINIMUM_AGE,
    };
  }

  // ─── 3.2.1 My profile ──────────────────────────────────────────────────────

  /** `hasProfile: false` with `profile: null` is a normal response, not a 404. */
  async me(userId: string) {
    const profile = await this.database.connectProfile.findUnique({
      where: { userId },
      include: profileInclude,
    });

    const pendingRequestCount = profile
      ? await this.database.connectionRequest.count({
          where: { toProfileId: profile.id, state: 'PENDING' },
        })
      : 0;

    return {
      hasProfile: profile !== null && profile.deletedAt === null,
      isVisible: profile?.isVisible ?? false,
      profile: profile && !profile.deletedAt ? await this.toView(profile) : null,
      // The banner count and the requests screen read the same number, so the two can never disagree (3.5.2).
      pendingRequestCount,
    };
  }

  // ─── 3.3.1 Upsert ──────────────────────────────────────────────────────────

  async upsert(userId: string, dto: UpsertConnectProfileDto) {
    await this.taxonomy.assertValid(TaxonomyKind.CONNECTION_TYPE, dto.typeCode, 'typeCode');

    if (dto.languages?.length) {
      await this.taxonomy.assertAllValid(TaxonomyKind.LANGUAGE, dto.languages, 'languages');
    }

    if (dto.interests?.length) {
      await this.taxonomy.assertAllValid(TaxonomyKind.INTEREST, dto.interests, 'interests');
    }

    if (dto.heritageTag) {
      await this.taxonomy.assertValid(TaxonomyKind.HERITAGE_TAG, dto.heritageTag, 'heritageTag');
    }

    const override = dto.cityIdOverride
      ? await this.cities.assertValid(dto.cityIdOverride, 'cityIdOverride')
      : null;

    const existingProfile = await this.database.userProfile.findUnique({
      where: { userId },
      select: { dateOfBirth: true },
    });

    let dateOfBirth = existingProfile?.dateOfBirth ?? null;

    if (dto.dateOfBirth) {
      if (dateOfBirth) {
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

      dateOfBirth = new Date(`${dto.dateOfBirth.slice(0, 10)}T00:00:00.000Z`);
    }

    if (!dateOfBirth) {
      throw ApiException.unprocessable(
        ApiErrorCode.DOB_REQUIRED,
        'We need your date of birth before you can join Connect.',
        { details: [{ field: 'dateOfBirth', message: 'This is required.' }] },
      );
    }

    const age = ageFromDateOfBirth(dateOfBirth);

    // Enforced here, not only in the client: client-side enforcement is a courtesy, not a control (3.1.2).
    if (age === null || age < CONNECT_MINIMUM_AGE) {
      throw ApiException.unprocessable(
        ApiErrorCode.UNDER_MINIMUM_AGE,
        `You need to be at least ${CONNECT_MINIMUM_AGE} to use Connect.`,
        { details: [{ field: 'dateOfBirth', message: `Must be ${CONNECT_MINIMUM_AGE} or over.` }] },
      );
    }

    // Dating carries an extra confirm step.
    if (dto.typeCode === 'DATING' && !dto.datingConfirmed) {
      throw ApiException.unprocessable(
        ApiErrorCode.DATING_CONFIRMATION_REQUIRED,
        'Please confirm you have read the safety guidance for dating connections.',
        { details: [{ field: 'datingConfirmed', message: 'This is required for dating.' }] },
      );
    }

    const profile = await this.database.$transaction(async tx => {
      // Writes through to the USER record, not to a Connect-only copy, which is what stops the app holding two disagreeing lists of a member's interests (3.1.3, D15).
      await tx.userProfile.upsert({
        where: { userId },
        update: {
          ...(dto.dateOfBirth ? { dateOfBirth, dateOfBirthSetAt: new Date() } : {}),
          ...(dto.languages !== undefined ? { languages: toJsonOrUndefined(dto.languages) } : {}),
          ...(dto.interests !== undefined ? { interests: toJsonOrUndefined(dto.interests) } : {}),
          ...(dto.heritageTag !== undefined ? { heritageTag: dto.heritageTag } : {}),
        },
        create: {
          userId,
          dateOfBirth,
          dateOfBirthSetAt: new Date(),
          languages: toJsonOrUndefined(dto.languages),
          interests: toJsonOrUndefined(dto.interests),
          heritageTag: dto.heritageTag ?? null,
        },
      });

      return tx.connectProfile.upsert({
        where: { userId },
        update: {
          typeCode: dto.typeCode,
          lookingFor: dto.lookingFor,
          dmPolicy: dto.dmPolicy ?? undefined,
          ...(dto.isVisible !== undefined ? { isVisible: dto.isVisible } : {}),
          cityIdOverride: override?.id ?? null,
          ...(dto.typeCode === 'DATING' ? { datingConfirmedAt: new Date() } : {}),
          deletedAt: null,
          lastActiveAt: new Date(),
        },
        create: {
          userId,
          typeCode: dto.typeCode,
          lookingFor: dto.lookingFor,
          dmPolicy: dto.dmPolicy ?? DmPolicy.REQUEST_FIRST,
          isVisible: dto.isVisible ?? false,
          cityIdOverride: override?.id ?? null,
          datingConfirmedAt: dto.typeCode === 'DATING' ? new Date() : null,
        },
        include: profileInclude,
      });
    });

    return this.toView(profile);
  }

  // ─── 3.3.2 Leave Connect ───────────────────────────────────────────────────

  /** Removes the profile and all pending requests in both directions. */
  async remove(userId: string): Promise<void> {
    const profile = await this.database.connectProfile.findUnique({ where: { userId } });

    if (!profile) return;

    await this.database.$transaction(async tx => {
      await tx.connectionRequest.deleteMany({
        where: {
          state: 'PENDING',
          OR: [{ fromProfileId: profile.id }, { toProfileId: profile.id }],
        },
      });

      await tx.connectProfile.delete({ where: { id: profile.id } });
    });
  }

  // ─── Serialisation ─────────────────────────────────────────────────────────

  async toView(profile: ConnectProfileRow): Promise<ConnectProfileView> {
    const [typeLabels, languageLabels, interestLabels, heritageLabels, stageLabels, countryLabels] =
      await Promise.all([
        this.taxonomy.labels(TaxonomyKind.CONNECTION_TYPE),
        this.taxonomy.labels(TaxonomyKind.LANGUAGE),
        this.taxonomy.labels(TaxonomyKind.INTEREST),
        this.taxonomy.labels(TaxonomyKind.HERITAGE_TAG),
        this.taxonomy.labels(TaxonomyKind.JOURNEY_STAGE),
        this.taxonomy.labels(TaxonomyKind.COUNTRY_OF_ORIGIN),
      ]);

    const userProfile = profile.user.profile;
    const languages = ((userProfile?.languages as string[] | null) ?? []).map(code =>
      toTermView(code, languageLabels),
    );
    const interests = ((userProfile?.interests as string[] | null) ?? []).map(code =>
      toTermView(code, interestLabels),
    );

    return {
      id: profile.id,
      user: toAuthorView(profile.user, { sign: this.media.sign }),
      // Derived from the single date of birth, never stored as a number (3.1.2).
      age: ageFromDateOfBirth(userProfile?.dateOfBirth ?? null),
      type: toTermView(profile.typeCode, typeLabels),
      lookingFor: profile.lookingFor,
      languages: languages.filter(Boolean) as TermView[],
      interests: interests.filter(Boolean) as TermView[],
      heritageTag: toTermView(userProfile?.heritageTag ?? null, heritageLabels),
      journeyStage: toTermView(userProfile?.journeyStage ?? null, stageLabels),
      countryOfOrigin: toTermView(userProfile?.countryOfOrigin ?? null, countryLabels),
      // The override reads as intent ("looking to connect in London") rather than a claim about where they are (D18).
      city: toCityView(profile.city ?? userProfile?.city ?? null),
      dmPolicy: profile.dmPolicy,
      // D13: nothing holds an identity check this version, so no card shows a badge.
      isVerified: (profile.user.trustChecks ?? []).some(
        check => check.check === TrustCheckType.IDENTITY,
      ),
      isVisible: profile.isVisible,
    };
  }

  /** Loads a profile by its own id or by the member's user id (3.2.3). */
  async findByIdOrUserId(idOrUserId: string): Promise<ConnectProfileRow | null> {
    return this.database.connectProfile.findFirst({
      where: { OR: [{ id: idOrUserId }, { userId: idOrUserId }], deletedAt: null },
      include: profileInclude,
    });
  }

  async requireOwn(userId: string): Promise<ConnectProfile> {
    const profile = await this.database.connectProfile.findUnique({ where: { userId } });

    if (!profile || profile.deletedAt) {
      // The reciprocity gate.
      throw ApiException.forbidden(
        ApiErrorCode.CONNECT_PROFILE_REQUIRED,
        'Set up your Connect profile to browse other members.',
      );
    }

    return profile;
  }
}
