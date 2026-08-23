import { Injectable } from '@nestjs/common';
import {
  ExperienceLevel,
  ListingVerificationStatus,
  Prisma,
  ProfessionalListing,
  TaxonomyKind,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException, money } from '@/common';
import {
  CityService,
  TaxonomyService,
  authorSelect,
  toAuthorView,
  toCityView,
  toTermView,
} from '../../shared';
import {
  AvailabilityDto,
  CreateListingDto,
  PromoteOfferDto,
  ReplaceServicesDto,
  ServiceDto,
  UpdateListingDto,
  UpdateServiceDto,
} from '../dtos/listing.dto';
import { ReputationService } from '../../trust/services/reputation.service';
import { VerificationService } from '../../trust/services/verification.service';
import { toServiceView } from '../serializers/listing.serializer';

/** The consent text version stored with a listing, so what was agreed is recoverable. */
const CONSENT_VERSION = '2026-08-professional-listing-v1';

export interface RegistrationStep {
  key: 'LISTING' | 'IDENTITY' | 'RIGHT_TO_WORK' | 'CREDENTIAL' | 'REVIEW';
  status: 'REQUIRED' | 'PREFILLED' | 'SATISFIED' | 'NOT_APPLICABLE';
  source: string | null;
  verifiedAt?: string;
}

@Injectable()
export class ListingService {
  constructor(
    private readonly database: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly cities: CityService,
    private readonly reputation: ReputationService,
    private readonly verification: VerificationService,
  ) {}

  // ─── 2.1.2 Registration prefill ────────────────────────────────────────────

  /**
   * One call, made when the member opens "Become a Professional", telling the
   * client every value it already has and every step it can skip.
   *
   * Without this the client cannot know what to hide, and the flow reverts to
   * asking everything — which is the whole failure this endpoint exists to
   * prevent. A member who typed their city during onboarding and is asked for it
   * again while registering learns that the app is several apps in a trench coat.
   */
  async registrationPrefill(userId: string, categoryCode?: string) {
    const [user, listing, offers] = await Promise.all([
      this.database.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          firstName: true,
          lastName: true,
          profileImageUrl: true,
          profile: {
            select: {
              cityId: true,
              city: { select: { id: true, name: true, region: true } },
              phoneNumber: true,
              phoneNumberDiallingCode: true,
              bio: true,
              canHelpWith: true,
            },
          },
        },
      }),
      this.database.professionalListing.findUnique({
        where: { userId },
        include: {
          city: { select: { id: true, name: true, region: true } },
          categories: true,
          services: true,
        },
      }),
      // Community offers by this member that could become the listing (2.1.3).
      this.database.communityOffer.findMany({
        where: { authorId: userId, deletedAt: null, promotedToListingId: null },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);

    const profile = user.profile;
    // Labelled, so the client can say "from your profile" rather than passing
    // prefilled text off as something the member wrote here (2.1.2).
    const aboutSource = profile?.bio
      ? 'PROFILE_BIO'
      : profile?.canHelpWith
        ? 'CAN_HELP_WITH'
        : null;
    const categoryLabels = await this.taxonomy.labels(TaxonomyKind.COMMUNITY_CATEGORY);

    const suggestions = await Promise.all(
      offers.map(async offer => {
        const term = await this.taxonomy.get(TaxonomyKind.COMMUNITY_CATEGORY, offer.categoryCode);
        const suggested = (term?.metadata?.suggestedProfessionCodes as string[] | undefined) ?? [];

        return {
          id: offer.id,
          title: offer.title,
          description: offer.description,
          categoryCode: offer.categoryCode,
          categoryLabel: categoryLabels.get(offer.categoryCode) ?? offer.categoryCode,
          cityId: offer.cityId,
          priceFrom: offer.priceFrom,
          priceBasis: offer.priceBasis,
          deliveryMode: offer.deliveryMode,
          // D8's bridge: the community category suggests a profession, so the
          // member confirms rather than choosing from scratch.
          suggestedProfessionCodes: suggested,
        };
      }),
    );

    return {
      listing: listing ? await this.toOwnerView(listing) : null,
      prefill: {
        fullName: `${user.firstName} ${user.lastName}`.trim(),
        cityId: profile?.cityId ?? null,
        cityName: profile?.city?.name ?? null,
        phoneNumber:
          profile?.phoneNumber && profile.phoneNumberDiallingCode
            ? `${profile.phoneNumberDiallingCode}${profile.phoneNumber}`
            : (profile?.phoneNumber ?? null),
        avatarUrl: user.profileImageUrl,
        about: profile?.bio ?? profile?.canHelpWith ?? null,
        aboutSource,
      },
      promotableOffers: suggestions,
      steps: await this.registrationSteps(userId, categoryCode),
    };
  }

  /**
   * The stepper renders from this array rather than a hardcoded count, which is
   * what lets verification appear later as a server change rather than an app
   * release (2.1.2, D13).
   *
   * In this version it is `[{ key: 'LISTING', status: 'REQUIRED' }]` alone.
   */
  private async registrationSteps(
    userId: string,
    categoryCode?: string,
  ): Promise<RegistrationStep[]> {
    const listing = await this.database.professionalListing.findUnique({
      where: { userId },
      select: { id: true },
    });

    const steps: RegistrationStep[] = [
      {
        key: 'LISTING',
        status: listing ? 'SATISFIED' : 'REQUIRED',
        source: listing ? 'LISTING' : null,
      },
    ];

    // D13: verification does not ship this release, so no IDENTITY,
    // RIGHT_TO_WORK or CREDENTIAL step is emitted. When it does ship, this is
    // where those steps are appended — read from VerificationService, marked
    // SATISFIED with the date they were verified, and the stepper picks them up
    // without an app release. `categoryCode` is accepted now so the client's
    // `?categoryCode=LEGAL` re-request already has somewhere to land.
    void categoryCode;

    return steps;
  }

  // ─── 2.6.1 Create ──────────────────────────────────────────────────────────

  async create(userId: string, dto: CreateListingDto) {
    const existing = await this.database.professionalListing.findUnique({
      where: { userId },
      include: { city: true, categories: true, services: true },
    });

    if (existing) {
      // The existing listing goes in `data` so the client opens it rather than
      // dead-ending on the error (2.1.6).
      throw ApiException.conflict(
        ApiErrorCode.LISTING_ALREADY_EXISTS,
        'You already have a professional listing.',
        { data: { listing: await this.toOwnerView(existing) } },
      );
    }

    await this.taxonomy.assertAllValid(TaxonomyKind.PROFESSION, dto.categoryCodes, 'categoryCodes');

    const cityId = dto.cityId ?? (await this.profileCityId(userId));

    if (!cityId) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'We need a city for your listing.',
        { details: [{ field: 'cityId', message: 'This is required.' }] },
      );
    }

    await this.cities.assertValid(cityId);

    const listing = await this.database.$transaction(async tx => {
      const created = await tx.professionalListing.create({
        data: {
          userId,
          professionTitle: dto.professionTitle,
          experienceLevel: dto.experienceLevel,
          yearsExperience: dto.yearsExperience ?? null,
          about: dto.about,
          cityId,
          deliveryMode: dto.deliveryMode ?? undefined,
          priceFrom: dto.priceFrom ?? null,
          priceBasis: dto.priceBasis ?? undefined,
          consentAccepted: true,
          consentAcceptedAt: new Date(),
          consentVersion: CONSENT_VERSION,
          sourceOfferId: dto.sourceOfferId ?? null,
          // D13: listings go live UNVERIFIED and are browsable, bookable and
          // messageable immediately. Never VERIFIED, because nothing has been
          // checked.
          verificationStatus: ListingVerificationStatus.UNVERIFIED,
          categories: {
            create: dto.categoryCodes.map((code, index) => ({ code, isPrimary: index === 0 })),
          },
        },
        include: { city: true, categories: true, services: true },
      });

      if (dto.sourceOfferId) {
        await tx.communityOffer.updateMany({
          where: { id: dto.sourceOfferId, authorId: userId },
          data: { promotedToListingId: created.id },
        });
      }

      return created;
    });

    return {
      listing: await this.toOwnerView(listing),
      steps: await this.registrationSteps(userId),
    };
  }

  // ─── 2.1.3 Promote a community offer ───────────────────────────────────────

  /**
   * A member who already posted "I can help with UK visa paperwork" has written
   * the listing. Make it a promotion, not a retype.
   */
  async promoteOffer(userId: string, offerId: string, dto: PromoteOfferDto) {
    const offer = await this.database.communityOffer.findUnique({ where: { id: offerId } });

    if (!offer || offer.deletedAt || offer.authorId !== userId) {
      throw ApiException.notFound('That offer could not be found.');
    }

    if (offer.promotedToListingId) {
      const listing = await this.database.professionalListing.findUnique({
        where: { id: offer.promotedToListingId },
        include: { city: true, categories: true, services: true },
      });

      throw ApiException.conflict(
        ApiErrorCode.OFFER_ALREADY_PROMOTED,
        'This offer has already become a professional listing.',
        { data: { listing: listing ? await this.toOwnerView(listing) : null } },
      );
    }

    const existing = await this.database.professionalListing.findUnique({
      where: { userId },
      include: { city: true, categories: true, services: true },
    });

    if (existing) {
      throw ApiException.conflict(
        ApiErrorCode.LISTING_ALREADY_EXISTS,
        'You already have a professional listing.',
        { data: { listing: await this.toOwnerView(existing) } },
      );
    }

    // The profession is usually the only field the member has to supply, and even
    // that is suggested by the community category (D8).
    const professionCode = dto.professionCode ?? (await this.suggestProfession(offer.categoryCode));

    if (!professionCode) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'Choose the professional category for this listing.',
        { details: [{ field: 'professionCode', message: 'This is required.' }] },
      );
    }

    await this.taxonomy.assertValid(TaxonomyKind.PROFESSION, professionCode, 'professionCode');

    const cityId = dto.cityId ?? offer.cityId;

    await this.cities.assertValid(cityId);

    const about = dto.about ?? offer.description;

    const listing = await this.database.$transaction(async tx => {
      const created = await tx.professionalListing.create({
        data: {
          userId,
          professionTitle: dto.title ?? offer.title.slice(0, 80),
          experienceLevel: dto.experienceLevel ?? ExperienceLevel.MID_LEVEL,
          about,
          cityId,
          // Copied across: delivery mode, price and basis all carry over, because
          // the member already decided them once.
          deliveryMode: offer.deliveryMode,
          priceFrom: offer.priceFrom,
          priceBasis: offer.priceBasis,
          consentAccepted: dto.consentAccepted ?? true,
          consentAcceptedAt: new Date(),
          consentVersion: CONSENT_VERSION,
          // The two records stay linked in both directions.
          sourceOfferId: offer.id,
          verificationStatus: ListingVerificationStatus.UNVERIFIED,
          categories: { create: [{ code: professionCode, isPrimary: true }] },
        },
        include: { city: true, categories: true, services: true },
      });

      // The offer stays live until the listing is verified (2.1.3). Until then,
      // both are visible — which is what lets a member keep helping for free
      // while their listing waits.
      await tx.communityOffer.update({
        where: { id: offer.id },
        data: { promotedToListingId: created.id },
      });

      return created;
    });

    return {
      listing: await this.toOwnerView(listing),
      steps: await this.registrationSteps(userId),
    };
  }

  // ─── 2.6.2 Patch ───────────────────────────────────────────────────────────

  async update(userId: string, id: string, dto: UpdateListingDto) {
    const listing = await this.assertOwned(userId, id);

    if (dto.categoryCodes?.length) {
      await this.taxonomy.assertAllValid(
        TaxonomyKind.PROFESSION,
        dto.categoryCodes,
        'categoryCodes',
      );
    }

    if (dto.cityId) await this.cities.assertValid(dto.cityId);

    const updated = await this.database.$transaction(async tx => {
      if (dto.categoryCodes?.length) {
        await tx.professionalListingCategory.deleteMany({ where: { listingId: listing.id } });
        await tx.professionalListingCategory.createMany({
          data: dto.categoryCodes.map((code, index) => ({
            listingId: listing.id,
            code,
            isPrimary: index === 0,
          })),
        });
      }

      return tx.professionalListing.update({
        where: { id: listing.id },
        data: {
          professionTitle: dto.professionTitle,
          experienceLevel: dto.experienceLevel,
          yearsExperience: dto.yearsExperience,
          about: dto.about,
          cityId: dto.cityId,
          deliveryMode: dto.deliveryMode,
          priceFrom: dto.priceFrom,
          priceBasis: dto.priceBasis,
          freeConsultation: dto.freeConsultation,
        },
        include: { city: true, categories: true, services: true },
      });
    });

    return this.toOwnerView(updated);
  }

  // ─── 2.6.3 Services ────────────────────────────────────────────────────────

  async addService(userId: string, listingId: string, dto: ServiceDto) {
    const listing = await this.assertOwned(userId, listingId);
    const count = await this.database.professionalService.count({
      where: { listingId: listing.id },
    });

    const service = await this.database.professionalService.create({
      data: {
        listingId: listing.id,
        name: dto.name,
        description: dto.description ?? null,
        price: dto.price ?? null,
        priceBasis: dto.priceBasis ?? undefined,
        isActive: dto.isActive ?? true,
        sort: count,
      },
    });

    return toServiceView(service);
  }

  async updateService(userId: string, listingId: string, serviceId: string, dto: UpdateServiceDto) {
    const listing = await this.assertOwned(userId, listingId);
    const service = await this.database.professionalService.findUnique({
      where: { id: serviceId },
    });

    if (!service || service.listingId !== listing.id) {
      throw ApiException.notFound('That service could not be found.');
    }

    const updated = await this.database.professionalService.update({
      where: { id: serviceId },
      data: {
        name: dto.name,
        description: dto.description,
        price: dto.price,
        priceBasis: dto.priceBasis,
        isActive: dto.isActive,
      },
    });

    return toServiceView(updated);
  }

  /**
   * A service is never hard-deleted while a booking references it: the booking
   * would lose its own subject (2.6.3). It is deactivated instead, and the client
   * is told which happened.
   */
  async removeService(userId: string, listingId: string, serviceId: string) {
    const listing = await this.assertOwned(userId, listingId);
    const service = await this.database.professionalService.findUnique({
      where: { id: serviceId },
    });

    if (!service || service.listingId !== listing.id) {
      throw ApiException.notFound('That service could not be found.');
    }

    const bookings = await this.database.booking.count({ where: { serviceId } });

    if (bookings > 0) {
      const deactivated = await this.database.professionalService.update({
        where: { id: serviceId },
        data: { isActive: false },
      });

      return { removed: false, service: toServiceView(deactivated) };
    }

    await this.database.professionalService.delete({ where: { id: serviceId } });

    return { removed: true, service: null };
  }

  /** The manage panel's bulk save. Same deletion rule as above, per row. */
  async replaceServices(userId: string, listingId: string, dto: ReplaceServicesDto) {
    const listing = await this.assertOwned(userId, listingId);

    await this.database.$transaction(async tx => {
      const existing = await tx.professionalService.findMany({
        where: { listingId: listing.id },
        select: { id: true },
      });

      const booked = await tx.booking.findMany({
        where: { serviceId: { in: existing.map(row => row.id) } },
        select: { serviceId: true },
        distinct: ['serviceId'],
      });
      const bookedIds = new Set(booked.map(row => row.serviceId).filter(Boolean) as string[]);

      await tx.professionalService.deleteMany({
        where: { listingId: listing.id, id: { notIn: [...bookedIds] } },
      });

      if (bookedIds.size) {
        await tx.professionalService.updateMany({
          where: { id: { in: [...bookedIds] } },
          data: { isActive: false },
        });
      }

      await tx.professionalService.createMany({
        data: dto.services.map((service, index) => ({
          listingId: listing.id,
          name: service.name,
          description: service.description ?? null,
          price: service.price ?? null,
          priceBasis: service.priceBasis ?? undefined,
          isActive: service.isActive ?? true,
          sort: index,
        })),
      });
    });

    const services = await this.database.professionalService.findMany({
      where: { listingId: listing.id },
      orderBy: { sort: 'asc' },
    });

    return services.map(toServiceView);
  }

  // ─── 2.6.4 Availability ────────────────────────────────────────────────────

  async setAvailability(userId: string, listingId: string, dto: AvailabilityDto) {
    const listing = await this.assertOwned(userId, listingId);

    const updated = await this.database.professionalListing.update({
      where: { id: listing.id },
      data: { isAcceptingWork: dto.isAcceptingWork },
      include: { city: true, categories: true, services: true },
    });

    return this.toOwnerView(updated);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /** `GET /professionals/me`: the caller's own listing, or 404 (2.4). */
  async findMine(userId: string) {
    const listing = await this.database.professionalListing.findUnique({
      where: { userId },
      include: { city: true, categories: true, services: true },
    });

    if (!listing || listing.deletedAt) {
      // 404 is how the home screen knows to show the two mode cards.
      throw ApiException.notFound(
        'You do not have a professional listing yet.',
        ApiErrorCode.LISTING_NOT_FOUND,
      );
    }

    return this.toOwnerView(listing);
  }

  async toOwnerView(
    listing: ProfessionalListing & {
      city?: { id: string; name: string; region: string | null } | null;
      categories?: Array<{ code: string; isPrimary: boolean }>;
      services?: Array<Parameters<typeof toServiceView>[0]>;
    },
  ) {
    const [professionLabels, summary, user, regulated] = await Promise.all([
      this.taxonomy.labels(TaxonomyKind.PROFESSION),
      this.reputation.summaryFor(listing.userId),
      this.database.user.findUnique({ where: { id: listing.userId }, select: authorSelect }),
      this.isRegulated(listing.categories?.map(category => category.code) ?? []),
    ]);

    const categories = (listing.categories ?? []).map(category =>
      toTermView(category.code, professionLabels),
    );

    return {
      id: listing.id,
      user: toAuthorView(user),
      professionTitle: listing.professionTitle,
      category: categories[0] ?? null,
      categories,
      city: toCityView(listing.city),
      experienceLevel: listing.experienceLevel,
      yearsExperience: listing.yearsExperience,
      about: listing.about,
      deliveryMode: listing.deliveryMode,
      priceFrom: money(listing.priceFrom, listing.currency),
      priceBasis: listing.priceBasis,
      isAcceptingWork: listing.isAcceptingWork,
      freeConsultation: listing.freeConsultation,
      verificationStatus: listing.verificationStatus,
      isRegulated: regulated,
      rating: this.reputation.toRatingView(summary),
      serviceCount: listing.services?.length ?? 0,
      services: (listing.services ?? []).map(toServiceView),
      stats: {
        jobsCompleted: listing.jobsCompleted,
        medianResponseMinutes: listing.medianResponseMinutes,
        profileViews: listing.profileViews,
      },
      createdAt: listing.createdAt.toISOString(),
    };
  }

  /**
   * D13: without credential checks, someone can list as an immigration adviser
   * and nobody has verified it. Giving immigration advice in the UK without IAA
   * registration is a criminal offence, and the exposure sits with the platform
   * that listed them. Surfacing `isRegulated` is not verification — it is the
   * difference between an unchecked claim and an unchecked claim that says so.
   */
  async isRegulated(codes: string[]): Promise<boolean> {
    for (const code of codes) {
      const term = await this.taxonomy.get(TaxonomyKind.PROFESSION, code);

      if (term?.metadata?.isRegulated === true) return true;
    }

    return false;
  }

  private async suggestProfession(communityCategoryCode: string): Promise<string | null> {
    const term = await this.taxonomy.get(TaxonomyKind.COMMUNITY_CATEGORY, communityCategoryCode);
    const suggested = (term?.metadata?.suggestedProfessionCodes as string[] | undefined) ?? [];

    return suggested[0] ?? null;
  }

  private async profileCityId(userId: string): Promise<string | null> {
    const profile = await this.database.userProfile.findUnique({
      where: { userId },
      select: { cityId: true },
    });

    return profile?.cityId ?? null;
  }

  private async assertOwned(userId: string, listingId: string) {
    const listing = await this.database.professionalListing.findUnique({
      where: { id: listingId },
    });

    if (!listing || listing.deletedAt) {
      throw ApiException.notFound(
        'That listing could not be found.',
        ApiErrorCode.LISTING_NOT_FOUND,
      );
    }

    if (listing.userId !== userId) {
      throw ApiException.forbidden(ApiErrorCode.FORBIDDEN, 'This is not your listing.');
    }

    return listing;
  }
}

export type ListingWithRelations = Prisma.ProfessionalListingGetPayload<{
  include: { city: true; categories: true; services: true };
}>;
