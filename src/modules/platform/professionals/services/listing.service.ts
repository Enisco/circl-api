import { Injectable } from '@nestjs/common';
import {
  ContentScanTrigger,
  ExperienceLevel,
  JobState,
  ListingReviewState,
  ListingVerificationStatus,
  Prisma,
  ProfessionalListing,
  ReportTargetType,
  TaxonomyKind,
  ThreadContextType,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException, money } from '@/common';
import {
  CityService,
  ContentSafetyService,
  ListingDocumentService,
  ListingReviewService,
  MediaService,
  TaxonomyService,
  authorSelect,
  displayNameOf,
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
import { toListingPictures, toServiceView } from '../serializers/listing.serializer';

/**
 * The states in which a listing is **live**, and its professions therefore fixed (§2.9).
 *
 * `NOT_REQUIRED` is as live as `APPROVED` — it is a listing in a profession that needs no
 * approval, or one that predates its profession being gated — and both are publicly visible. The
 * two that stay editable are the ones nobody can see yet: `PENDING` is waiting, and `REJECTED` was
 * declined, where changing the profession is the point of resubmitting.
 */
const LIVE_REVIEW_STATES: ListingReviewState[] = [
  ListingReviewState.APPROVED,
  ListingReviewState.NOT_REQUIRED,
];

/** The consent text version stored with a listing, so what was agreed is recoverable. */
const CONSENT_VERSION = '2026-08-professional-listing-v1';

/** The listing's own pictures, owned by the listing rather than by the member (2.1).  */
export const LISTING_PHOTO_OWNER = 'LISTING_PHOTO';
export const LISTING_COVER_OWNER = 'LISTING_COVER';

export interface RegistrationStep {
  key: 'LISTING' | 'IDENTITY' | 'RIGHT_TO_WORK' | 'CREDENTIAL' | 'REVIEW';
  status: 'REQUIRED' | 'PREFILLED' | 'SATISFIED' | 'NOT_APPLICABLE';
  source: string | null;
  verifiedAt?: string;
}

/** Below this, `responseRate` is null (2.4): one missed message should not read as a bad record. */
const MIN_ENQUIRIES_FOR_RATE = 3;

@Injectable()
export class ListingService {
  constructor(
    private readonly database: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly cities: CityService,
    private readonly reputation: ReputationService,
    private readonly verification: VerificationService,
    private readonly media: MediaService,
    private readonly safety: ContentSafetyService,
    private readonly reviews: ListingReviewService,
    private readonly documents: ListingDocumentService,
  ) {}

  // ─── 2.1.2 Registration prefill ────────────────────────────────────────────

  /** One call, made when the member opens "Become a Professional", telling the client every value it already has and every step it can skip. */
  async registrationPrefill(userId: string, categoryCode?: string) {
    const [user, listing, offers] = await Promise.all([
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
              // Selected because the author object carries `countryCode` (0.9); a hand-rolled
              // select that omits it returns null rather than failing, which is worse.
              countryOfOrigin: true,
              phoneNumber: true,
              phoneNumberDiallingCode: true,
              bio: true,
              canHelpWith: true,
            },
          },
        },
      }),
      // visibility: the caller's own listing, on their own screen.
      this.database.professionalListing.findUnique({
        where: { userId },
        include: {
          city: { select: { id: true, name: true, region: true } },
          categories: true,
          services: true,
        },
      }),
      // Community offers by this member that could become the listing (2.1.3).
      // visibility: the caller's own offers, as candidates to promote into a listing.
      this.database.communityOffer.findMany({
        where: { authorId: userId, deletedAt: null, promotedToListingId: null },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);

    const profile = user.profile;
    // Labelled, so the client can say "from your profile" rather than passing prefilled text off as something the member wrote here (2.1.2).
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
          // D8's bridge: the community category suggests a profession, so the member confirms rather than choosing from scratch.
          suggestedProfessionCodes: suggested,
        };
      }),
    );

    return {
      listing: listing ? await this.toOwnerView(listing) : null,
      prefill: {
        fullName: displayNameOf(user.firstName, user.lastName),
        cityId: profile?.cityId ?? null,
        cityName: profile?.city?.name ?? null,
        phoneNumber:
          profile?.phoneNumber && profile.phoneNumberDiallingCode
            ? `${profile.phoneNumberDiallingCode}${profile.phoneNumber}`
            : (profile?.phoneNumber ?? null),
        avatarUrl: user.avatarKey ? this.media.sign(user.avatarKey) : user.profileImageUrl,
        about: profile?.bio ?? profile?.canHelpWith ?? null,
        aboutSource,
      },
      promotableOffers: suggestions,
      steps: await this.registrationSteps(userId, categoryCode),
    };
  }

  /** The stepper renders from this array rather than a hardcoded count, which is what lets verification appear later as a server change rather than an app release (2.1.2, D13). */
  private async registrationSteps(
    userId: string,
    categoryCode?: string,
  ): Promise<RegistrationStep[]> {
    // visibility: whether the caller has a listing yet, for the registration steps.
    const listing = await this.database.professionalListing.findUnique({
      where: { userId },
      select: { id: true, reviewState: true, categories: { select: { code: true } } },
    });

    const steps: RegistrationStep[] = [
      {
        key: 'LISTING',
        status: listing ? 'SATISFIED' : 'REQUIRED',
        source: listing ? 'LISTING' : null,
      },
    ];

    // D13: verification does not ship this release, so no IDENTITY, RIGHT_TO_WORK or CREDENTIAL
    // step is emitted.

    // §2.9's step, which is the thing this array was built to make possible: a stepper that reads
    // its steps from the server can gain one without an app release. Emitted for the category the
    // member is choosing *before* they have a listing, so the form can say up front that this one
    // is reviewed rather than surprising them after they submit.
    const codes = categoryCode
      ? [categoryCode]
      : (listing?.categories.map(category => category.code) ?? []);
    const gated = await this.reviews.gatedCodes(codes);

    if (gated.length) {
      steps.push({
        key: 'REVIEW',
        // Only approval satisfies it. A decline is `REQUIRED` again, which is the honest reading:
        // there is still something for the member to do.
        status: listing?.reviewState === ListingReviewState.APPROVED ? 'SATISFIED' : 'REQUIRED',
        source: gated[0],
      });
    }

    return steps;
  }

  // ─── 2.6.1 Create ──────────────────────────────────────────────────────────

  async create(userId: string, dto: CreateListingDto) {
    // visibility: the caller's own listing, to refuse a second one.
    const existing = await this.database.professionalListing.findUnique({
      where: { userId },
      include: { city: true, categories: true, services: true },
    });

    if (existing) {
      // The existing listing goes in `data` so the client opens it rather than dead-ending on the error (2.1.6).
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

    const [photo, cover] = await Promise.all([
      this.singleImage(dto.photoKey, userId),
      this.singleImage(dto.coverKey, userId),
    ]);

    // §2.9: whether a human has to approve this before anybody can find it. Worked out before the
    // transaction because it is a taxonomy read per code, and the write below needs the answer.
    const gated = await this.reviews.gatedCodes(dto.categoryCodes);
    // §2.9's documents. Both halves run **before** the transaction: the count check so a refusal
    // leaves nothing behind, and the preparation because it reads and rewrites bytes in storage —
    // holding a database transaction open across that would make a listing write wait on S3.
    const documentIds = this.documents.assertCount({
      documentIds: dto.documentIds,
      needsApproval: gated.length > 0,
    });
    const documents = await this.documents.prepare({ documentIds, uploaderId: userId });

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
          photoKey: photo?.storageKey ?? null,
          coverKey: cover?.storageKey ?? null,
          // D13: listings go live UNVERIFIED and are browsable, bookable and messageable immediately.
          verificationStatus: ListingVerificationStatus.UNVERIFIED,
          categories: {
            create: dto.categoryCodes.map((code, index) => ({ code, isPrimary: index === 0 })),
          },
        },
        include: { city: true, categories: true, services: true },
      });

      if (photo) await this.media.attach(tx, [photo], LISTING_PHOTO_OWNER, created.id);
      if (cover) await this.media.attach(tx, [cover], LISTING_COVER_OWNER, created.id);

      if (dto.sourceOfferId) {
        await tx.communityOffer.updateMany({
          where: { id: dto.sourceOfferId, authorId: userId },
          data: { promotedToListingId: created.id },
        });
      }

      // §6.1 scans a listing's published copy: the title somebody browses and the paragraph they
      // read before hiring.
      await this.safety.assess(tx, {
        targetType: ReportTargetType.PROFESSIONAL_LISTING,
        targetId: created.id,
        authorId: userId,
        fields: { professionTitle: created.professionTitle, about: created.about },
        trigger: ContentScanTrigger.CREATE,
        summary: created.professionTitle,
        requiresApproval: gated.length > 0,
      });

      // Merged rather than discarded: `created` was read before the hold and before `assess`
      // mirrored the visibility onto it, so serialising it as-is told the member their listing was
      // live while the database said it was held. The includes stay; only the scalars move.
      if (documents.length) await this.documents.setCurrent(tx, created.id, documents);

      if (gated.length) Object.assign(created, await this.reviews.hold(tx, created, gated));

      return created;
    });

    return {
      listing: await this.toOwnerView(listing),
      steps: await this.registrationSteps(userId, dto.categoryCodes[0]),
    };
  }

  // ─── 2.1.3 Promote a community offer ───────────────────────────────────────

  /** A member who already posted "I can help with UK visa paperwork" has written the listing. */
  async promoteOffer(userId: string, offerId: string, dto: PromoteOfferDto) {
    // visibility: the caller's own offer, before it becomes a listing.
    const offer = await this.database.communityOffer.findUnique({ where: { id: offerId } });

    if (!offer || offer.deletedAt || offer.authorId !== userId) {
      throw ApiException.notFound('That offer could not be found.');
    }

    if (offer.promotedToListingId) {
      // visibility: the listing their offer already became — also theirs.
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

    // visibility: the caller's own listing, to refuse a second one.
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

    // The profession is usually the only field the member has to supply, and even that is suggested by the community category (D8).
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
    // Promoting an offer is a listing like any other, and "I can help with UK visa paperwork" is
    // the exact case §2.9 exists for: the bridge from a community offer must not be a way around
    // the gate the create path applies.
    const gated = await this.reviews.gatedCodes([professionCode]);
    const documentIds = this.documents.assertCount({
      documentIds: dto.documentIds,
      needsApproval: gated.length > 0,
    });
    const documents = await this.documents.prepare({ documentIds, uploaderId: userId });

    const listing = await this.database.$transaction(async tx => {
      const created = await tx.professionalListing.create({
        data: {
          userId,
          professionTitle: dto.title ?? offer.title.slice(0, 80),
          experienceLevel: dto.experienceLevel ?? ExperienceLevel.MID_LEVEL,
          about,
          cityId,
          // Copied across: delivery mode, price and basis all carry over, because the member already decided them once.
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

      // The offer stays live until the listing is verified (2.1.3).
      await tx.communityOffer.update({
        where: { id: offer.id },
        data: { promotedToListingId: created.id },
      });

      // §6.1 scans a listing's published copy: the title somebody browses and the paragraph they
      // read before hiring.
      await this.safety.assess(tx, {
        targetType: ReportTargetType.PROFESSIONAL_LISTING,
        targetId: created.id,
        authorId: userId,
        fields: { professionTitle: created.professionTitle, about: created.about },
        trigger: ContentScanTrigger.CREATE,
        summary: created.professionTitle,
        requiresApproval: gated.length > 0,
      });

      if (documents.length) await this.documents.setCurrent(tx, created.id, documents);

      if (gated.length) Object.assign(created, await this.reviews.hold(tx, created, gated));

      return created;
    });

    return {
      listing: await this.toOwnerView(listing),
      steps: await this.registrationSteps(userId, professionCode),
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

    const city = dto.cityId ? await this.cities.assertValid(dto.cityId) : null;
    const [photo, cover] = await Promise.all([
      this.singleImage(dto.photoKey, userId),
      this.singleImage(dto.coverKey, userId),
    ]);

    // §2.9. Three questions, and the answers have to be worked out from the row as it stands now,
    // before the patch overwrites it.
    //
    // `copyChanged` is only the two fields a reviewer actually reads. A member fixing their price
    // or turning off "accepting work" is not asking to be approved again, and sending them back
    // through the queue for it would teach them to avoid editing their listing at all.
    const current = await this.database.professionalListingCategory.findMany({
      where: { listingId: listing.id },
      select: { code: true },
    });
    const currentCodes = current.map(row => row.code);
    const codes = dto.categoryCodes?.length ? dto.categoryCodes : currentCodes;
    const copyChanged =
      (dto.professionTitle !== undefined && dto.professionTitle !== listing.professionTitle) ||
      (dto.about !== undefined && dto.about !== listing.about);
    const categoriesChanged =
      codes.length !== currentCodes.length || codes.some(code => !currentCodes.includes(code));

    // §2.9: a live listing's professions are fixed (BACKEND-NOTES-PROFESSION-LOCK, 2026-10-12).
    //
    // Enforced here rather than by hiding the picker, because a hidden picker stops nobody with a
    // modified client — and this is the control that closes the bypass the gating rule was holding
    // shut: register in an unrestricted profession, go live, then add a restricted one.
    //
    // `APPROVED` and `NOT_REQUIRED` are both live. A declined or waiting listing stays editable:
    // changing the profession is the whole point of a resubmission, and it is then judged as a new
    // account in the new profession.
    //
    // Checked against the **set**, not the array: the app sends `categoryCodes` on every edit
    // including a price change, so refusing an identical list would refuse every edit a live
    // professional ever makes. `categoriesChanged` above is already order-independent.
    if (categoriesChanged && LIVE_REVIEW_STATES.includes(listing.reviewState)) {
      throw ApiException.conflict(
        ApiErrorCode.PROFESSION_LOCKED,
        "Your profession can't be changed once your profile is live.",
        {
          data: { current: currentCodes, requested: codes, reviewState: listing.reviewState },
        },
      );
    }

    // What the listing is gated under *today*. The post-patch set is `gated`, which `verdictFor`
    // returns; this one decides whether there are documents to compare against at all.
    const gatedBefore = await this.reviews.gatedCodes(currentCodes);
    const attachedNow = gatedBefore.length ? await this.documents.current(listing.id) : [];
    const attachedNowIds = attachedNow.map(row => row.id);
    const documentsChanged =
      dto.documentIds !== undefined &&
      (dto.documentIds.length !== attachedNowIds.length ||
        dto.documentIds.some(id => !attachedNowIds.includes(id)));

    const { needsApproval, gated } = await this.reviews.verdictFor({
      codes,
      reviewState: listing.reviewState,
      copyChanged,
      categoriesChanged,
      documentsChanged,
      // What it was already gated on, so a listing that never needed a review is only pulled into
      // one by **adding** a profession that needs approving — not by editing its price.
      gatedBefore,
    });

    // §2.9's documents on an edit.
    //
    // `documentIds` absent means "leave them as they are", which is what a member changing their
    // price is doing. Present means it is the **whole** new set — so a resubmission that dropped
    // one is a list without it, and the count rule still applies to the result. Absent on a
    // still-gated listing is therefore checked against what is already attached, not against
    // nothing: otherwise every price change on a gated listing would be refused for having no
    // documents.
    //
    // Keyed on `needsApproval`, **not** on `gated.length`. A listing that existed before its
    // profession was gated needs no review (BACKEND-NOTES-NEW-ACCOUNTS-ONLY rule 3) and therefore
    // needs no documents — and it has none, because nobody ever asked. Reading `gated.length` here
    // refused every edit such a member made with `DOCUMENTS_REQUIRED`, asking for papers for a
    // review that was never going to happen: the same mistake as `verdictFor`, one field across.
    // Two independent questions, and conflating them broke both in turn:
    //
    //  - **Which documents does this listing have afterwards?** Absent means the ones it already
    //    has. Passing `[]` instead supersedes every one of them, so a member changing their price
    //    would silently destroy the papers their approval rests on — which is what keying this on
    //    `needsApproval` alone did.
    //  - **Does the count have to be met?** Only when this write needs approving. A listing that
    //    predates its profession being gated has no documents and needs none
    //    (BACKEND-NOTES-NEW-ACCOUNTS-ONLY rule 3); reading `gated.length` here refused every edit
    //    such a member made with `DOCUMENTS_REQUIRED`, demanding papers for a review that was
    //    never going to happen.
    const documentIds =
      dto.documentIds === undefined
        ? // Keep what is attached. Validated only when this write needs approving — passing them
          // through `assertCount` with `needsApproval: false` would *refuse* them, because for a
          // caller-supplied set "documents on a listing that needs none" is a mistake worth
          // naming. Here they are not supplied; they are simply already there.
          needsApproval
          ? this.documents.assertCount({ documentIds: attachedNowIds, needsApproval: true })
          : attachedNowIds
        : this.documents.assertCount({ documentIds: dto.documentIds, needsApproval });
    const documents = await this.documents.prepare({
      documentIds,
      uploaderId: userId,
      listingId: listing.id,
    });

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

      if (photo) await this.media.attach(tx, [photo], LISTING_PHOTO_OWNER, listing.id);
      if (cover) await this.media.attach(tx, [cover], LISTING_COVER_OWNER, listing.id);

      // An explicit null is the remove action. Absent is not: a member editing their price sends
      // neither key, and reading that as null would take their picture with it.
      if (dto.photoKey === null) {
        await this.media.releaseOwner(tx, LISTING_PHOTO_OWNER, listing.id);
      }

      if (dto.coverKey === null) {
        await this.media.releaseOwner(tx, LISTING_COVER_OWNER, listing.id);
      }

      const patched = await tx.professionalListing.update({
        where: { id: listing.id },
        data: {
          professionTitle: dto.professionTitle,
          experienceLevel: dto.experienceLevel,
          yearsExperience: dto.yearsExperience,
          about: dto.about,
          cityId: city?.id,
          deliveryMode: dto.deliveryMode,
          priceFrom: dto.priceFrom,
          priceBasis: dto.priceBasis,
          freeConsultation: dto.freeConsultation,
          ...(photo ? { photoKey: photo.storageKey } : {}),
          ...(cover ? { coverKey: cover.storageKey } : {}),
          ...(dto.photoKey === null ? { photoKey: null } : {}),
          ...(dto.coverKey === null ? { coverKey: null } : {}),
        },
        include: { city: true, categories: true, services: true },
      });

      // §6.1 scans a listing's published copy: the title somebody browses and the paragraph they
      // read before hiring.
      await this.safety.assess(tx, {
        targetType: ReportTargetType.PROFESSIONAL_LISTING,
        targetId: listing.id,
        authorId: userId,
        fields: { professionTitle: patched.professionTitle, about: patched.about },
        trigger: ContentScanTrigger.EDIT,
        summary: patched.professionTitle,
        requiresApproval: needsApproval,
      });

      if (gated.length) {
        await this.documents.setCurrent(tx, listing.id, documents);
      } else {
        // No longer asking to do anything that needs proving, so the platform stops holding their
        // certificates — after the retention window, so a decision taken while they were gated can
        // still be appealed against the evidence it was taken on.
        await this.documents.supersedeAll(tx, listing.id);
      }

      if (needsApproval) {
        Object.assign(patched, await this.reviews.hold(tx, patched, gated));
      } else if (!gated.length && listing.reviewState !== ListingReviewState.NOT_REQUIRED) {
        // The release half. A member who swapped a gated profession for an ungated one is no
        // longer asking to do the thing that needed approving, and must not be left waiting for a
        // review that is never coming.
        Object.assign(patched, await this.reviews.release(tx, listing.id));
      }

      return patched;
    });

    return this.toOwnerView(updated);
  }

  // ─── 2.6.3 Services ────────────────────────────────────────────────────────

  async addService(userId: string, listingId: string, dto: ServiceDto) {
    const listing = await this.assertOwned(userId, listingId);
    // visibility: the caller's own services, counted against the limit.
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

    // A service's name and description are published copy (§6.1), so they are scanned like any
    // other. One transaction, because the verdict and the row belong together.
    await this.database.$transaction(tx =>
      this.safety.assess(tx, {
        targetType: ReportTargetType.PROFESSIONAL_SERVICE,
        targetId: service.id,
        authorId: userId,
        fields: { name: service.name, description: service.description },
        trigger: ContentScanTrigger.CREATE,
        summary: service.name,
      }),
    );

    return toServiceView(service);
  }

  async updateService(userId: string, listingId: string, serviceId: string, dto: UpdateServiceDto) {
    const listing = await this.assertOwned(userId, listingId);
    // visibility: the caller's own service, before an edit.
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

    // A service's name and description are published copy (§6.1), so they are scanned like any
    // other. One transaction, because the verdict and the row belong together.
    await this.database.$transaction(tx =>
      this.safety.assess(tx, {
        targetType: ReportTargetType.PROFESSIONAL_SERVICE,
        targetId: updated.id,
        authorId: userId,
        fields: { name: updated.name, description: updated.description },
        trigger: ContentScanTrigger.EDIT,
        summary: updated.name,
      }),
    );

    return toServiceView(updated);
  }

  /** A service is never hard-deleted while a booking references it: the booking would lose its own subject (2.6.3). */
  async removeService(userId: string, listingId: string, serviceId: string) {
    const listing = await this.assertOwned(userId, listingId);
    // visibility: the caller's own service, before a delete.
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
      // visibility: the caller's own services, replaced wholesale.
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

    // visibility: the caller's own services, read back after the write.
    const services = await this.database.professionalService.findMany({
      where: { listingId: listing.id },
      orderBy: { sort: 'asc' },
    });

    // The whole set is replaced, so the whole set is scanned. The content hash means the ones
    // whose words did not change cost a lookup and nothing else.
    await this.database.$transaction(async tx => {
      for (const service of services) {
        await this.safety.assess(tx, {
          targetType: ReportTargetType.PROFESSIONAL_SERVICE,
          targetId: service.id,
          authorId: userId,
          fields: { name: service.name, description: service.description },
          trigger: ContentScanTrigger.EDIT,
          summary: service.name,
        });
      }
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
    // visibility: `GET /professionals/me` — their own listing, in whatever state it is in.
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
    const [professionLabels, summary, user, regulated, ownerStats] = await Promise.all([
      this.taxonomy.labels(TaxonomyKind.PROFESSION),
      this.reputation.summaryFor(listing.userId),
      this.database.user.findUnique({ where: { id: listing.userId }, select: authorSelect }),
      this.isRegulated(listing.categories?.map(category => category.code) ?? []),
      this.ownerStats(listing.id, listing.userId),
    ]);

    const categories = (listing.categories ?? []).map(category =>
      toTermView(category.code, professionLabels),
    );

    return {
      id: listing.id,
      user: toAuthorView(user, { sign: this.media.sign }),
      professionTitle: listing.professionTitle,
      ...toListingPictures(listing, this.media.sign),
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
      // §2.9. Null for the great majority of listings, which are in no gated profession and have
      // nothing to wait for — the client renders the banner only when this is present.
      review: await this.reviews.ownerView(listing),
      rating: this.reputation.toRatingView(summary),
      serviceCount: listing.services?.length ?? 0,
      services: (listing.services ?? []).map(toServiceView),
      stats: {
        jobsCompleted: listing.jobsCompleted,
        medianResponseMinutes: listing.medianResponseMinutes,
        profileViews: listing.profileViews,
        // Owner's copy only (2.4).
        ...ownerStats,
      },
      createdAt: listing.createdAt.toISOString(),
    };
  }

  /**
   * The two numbers the manage panel's summary row reads (2.4). Public because the profile a
   * professional opens of themselves shows them too, the way a seller's own shop page does, and
   * two copies of this counting would eventually count differently.
   */
  async ownerStats(
    listingId: string,
    professionalId: string,
  ): Promise<{ enquiries: number; responseRate: number | null }> {
    const [threads, bookings] = await Promise.all([
      this.database.conversation.findMany({
        where: { contextType: ThreadContextType.PROFESSIONAL, contextId: listingId },
        select: {
          participants: { select: { userId: true } },
          messages: { where: { senderId: professionalId }, select: { id: true }, take: 1 },
        },
      }),
      this.database.booking.findMany({
        where: { professionalId },
        select: { clientId: true, state: true },
      }),
    ]);

    // Answered wins over unanswered when the same person did both, because the question is whether the professional ever replied to that person at all.
    const answeredBy = new Map<string, boolean>();

    const note = (userId: string, answered: boolean) => {
      answeredBy.set(userId, (answeredBy.get(userId) ?? false) || answered);
    };

    for (const thread of threads) {
      const replied = thread.messages.length > 0;

      for (const participant of thread.participants) {
        if (participant.userId !== professionalId) note(participant.userId, replied);
      }
    }

    for (const booking of bookings) {
      // A booking left sitting in its opening state was never answered.
      note(booking.clientId, booking.state !== JobState.PENDING_ACCEPTANCE);
    }

    const enquiries = answeredBy.size;

    if (enquiries < MIN_ENQUIRIES_FOR_RATE) return { enquiries, responseRate: null };

    const answered = [...answeredBy.values()].filter(Boolean).length;

    // Integer percent, the same shape the store's counter uses: one formatter for both tracks.
    return { enquiries, responseRate: Math.round((answered / enquiries) * 100) };
  }

  /** D13: without credential checks, someone can list as an immigration adviser and nobody has verified it. */
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

  /** One image, validated as the shop's logo and cover are: an image, owned by this member. */
  private async singleImage(mediaId: string | null | undefined, userId: string) {
    if (!mediaId) return null;

    const [media] = await this.media.validate([mediaId], userId, {
      maxImages: 1,
      allowVideo: false,
      allowAudio: false,
    });

    return media ?? null;
  }

  private async profileCityId(userId: string): Promise<string | null> {
    const profile = await this.database.userProfile.findUnique({
      where: { userId },
      select: { cityId: true },
    });

    return profile?.cityId ?? null;
  }

  private async assertOwned(userId: string, listingId: string) {
    // visibility: an ownership check before a write.
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
