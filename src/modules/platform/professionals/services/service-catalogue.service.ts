import { Injectable } from '@nestjs/common';
import {
  ContentScanTrigger,
  ContentVisibilityState,
  Media,
  MediaRole,
  Prisma,
  ReportTargetType,
  ServiceOwnerState,
  TaxonomyKind,
} from '@prisma/client';
import { ApiErrorCode, ApiException, PageMeta, buildPageMeta } from '@/common';
import { PrismaService } from '@/infrastructure';
import {
  ContentSafetyService,
  MediaService,
  SERVICE_MEDIA_RULES,
  TaxonomyService,
  toMediaViews,
} from '@/modules/platform/shared';
import {
  CreateServiceDto,
  ListServicesDto,
  SERVICE_LIMITS,
  ServiceMediaKeyDto,
  ServiceMilestoneDto,
  ServiceUpdateDto,
  UpdateServiceDto,
} from '../dtos/service.dto';
import {
  ProfessionalRefView,
  ServiceView,
  isPublic,
  statusOf,
  toPriceLabel,
} from '../serializers/service.serializer';
import {
  CategoryVerificationService,
  VerificationState,
  effectiveStatus,
} from './category-verification.service';

/** Where a service's own media hangs. */
export const SERVICE_MEDIA_OWNER = 'PROFESSIONAL_SERVICE';

/**
 * Where a video's still frame is filed (v2 §9.2).
 *
 * Its own owner type, like Connect's poster, for two reasons: the gallery reads
 * `SERVICE_MEDIA_OWNER` and must not render the frame as an eleventh photograph, and the poster
 * has to be attached to something or the orphan sweep deletes it within the day and the thumbnail
 * breaks.
 */
export const SERVICE_POSTER_OWNER = 'PROFESSIONAL_SERVICE_POSTER';

/** Everything a service read needs in one query. */
const SERVICE_INCLUDE = {
  updates: { orderBy: { publishedAt: 'desc' } },
  milestones: { orderBy: { sort: 'asc' } },
  listing: {
    select: {
      id: true,
      userId: true,
      cityId: true,
      photoKey: true,
      visibilityState: true,
      city: { select: { id: true, name: true } },
      user: { select: { id: true, firstName: true, lastName: true, avatarKey: true } },
    },
  },
} satisfies Prisma.ProfessionalServiceInclude;

type ServiceRow = Prisma.ProfessionalServiceGetPayload<{ include: typeof SERVICE_INCLUDE }>;

/**
 * Services: the thing members search, read and judge (v2 §5).
 *
 * The inversion v2 is built on is that a service, not a profession, is the unit of the section —
 * so this owns its own writes, its own public page and its own list, and the professional becomes
 * the credential behind it.
 *
 * Two rules run through everything here:
 *
 *  - **The gate is derived, never stored** (§5.4). A service's visibility is a function of its
 *    category's verification, read fresh. Approving a category therefore publishes every waiting
 *    service in it at once, and a revocation suspends them all, with nothing to walk and update.
 *  - **Invisible means invisible** (§5.4). Anything other than `PUBLISHED` is absent from search,
 *    browse, the public profile and a direct fetch by anybody but its owner — and a direct fetch
 *    answers `404`, not `403`, because a `403` confirms the service exists and that is a
 *    disclosure about somebody's pending verification.
 */
@Injectable()
export class ServiceCatalogueService {
  constructor(
    private readonly database: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly media: MediaService,
    private readonly safety: ContentSafetyService,
    private readonly verifications: CategoryVerificationService,
  ) {}

  // ─── Writing ───────────────────────────────────────────────────────────────

  async create(userId: string, listingId: string, dto: CreateServiceDto): Promise<ServiceView> {
    const listing = await this.assertOwned(userId, listingId);

    /**
     * Which contract this request is asking for (§10).
     *
     * `categoryCode` is the marker: a build that sends one knows about v2 and is held to all of
     * it, and a build that does not is a live member on an older app whose price list has to keep
     * working. The legacy write gets the listing's primary category, the older `price` field, and
     * no subcategory requirement — the category it inherits may well have children, and demanding
     * a choice from a client that cannot render one would strand them.
     */
    const legacy = dto.categoryCode === undefined;
    const categoryCode = dto.categoryCode ?? (await this.primaryCategory(listing.id));

    if (!legacy) {
      if (!dto.description || dto.description.trim().length < SERVICE_LIMITS.descriptionMin) {
        throw ApiException.unprocessable(
          ApiErrorCode.VALIDATION_FAILED,
          `A service needs at least ${SERVICE_LIMITS.descriptionMin} characters. A one-line offer is not an offer.`,
          {
            details: [
              {
                field: 'description',
                message: `${dto.description?.trim().length ?? 0} characters, minimum ${SERVICE_LIMITS.descriptionMin}.`,
              },
            ],
          },
        );
      }

      if (dto.pricePence === undefined && dto.price === undefined) {
        throw ApiException.unprocessable(
          ApiErrorCode.VALIDATION_FAILED,
          'A service needs a price.',
          { details: [{ field: 'pricePence', message: 'Required.' }] },
        );
      }

      await this.assertCategory(categoryCode, dto.subcategoryCode);
    }

    // The gate, computed server-side whatever the client believed (§3.2), and on both shapes: an
    // older build must not be a way into regulated work. `PENDING` passes — the service is created
    // and sits invisible until a reviewer gets to it (§5.5).
    if (categoryCode) {
      await this.verifications.assertMayWrite(userId, categoryCode, dto.subcategoryCode);
    }

    // visibility: the caller's own services, counted against the limit — a hidden or held one
    // still occupies a slot, so this is deliberately every row.
    const count = await this.database.professionalService.count({
      where: { listingId: listing.id },
    });

    if (count >= SERVICE_LIMITS.perListing) {
      throw ApiException.unprocessable(
        ApiErrorCode.SERVICE_LIMIT_REACHED,
        `A profile holds up to ${SERVICE_LIMITS.perListing} services. Remove one before adding another.`,
        { data: { limit: SERVICE_LIMITS.perListing } },
      );
    }

    const media = await this.prepareMedia(userId, dto.mediaKeys);

    const created = await this.database.$transaction(async tx => {
      const service = await tx.professionalService.create({
        data: {
          listingId: listing.id,
          name: dto.name,
          description: dto.description ?? null,
          categoryCode,
          subcategoryCode: dto.subcategoryCode ?? null,
          price: dto.pricePence ?? dto.price ?? null,
          priceBasis: dto.priceBasis ?? undefined,
          sort: count,
          // An older client's `isActive: false` means "created hidden", which is the only thing
          // that field ever meant (§5.5.1).
          ownerState: dto.isActive === false ? ServiceOwnerState.HIDDEN : ServiceOwnerState.LIVE,
          isActive: dto.isActive ?? true,
        },
      });

      await this.writeUpdates(tx, service.id, dto.updates);
      await this.writeMilestones(tx, service.id, dto.milestones);
      await this.media.attach(tx, media.files, SERVICE_MEDIA_OWNER, service.id, media.roles);
      await this.media.attachPosters(tx, media.posters, SERVICE_POSTER_OWNER, service.id);

      // A service's name and description are published copy (§6.1), so they are scanned like any
      // other. One transaction, because the verdict and the row belong together.
      await this.safety.assess(tx, {
        targetType: ReportTargetType.PROFESSIONAL_SERVICE,
        targetId: service.id,
        authorId: userId,
        fields: { name: service.name, description: service.description },
        trigger: ContentScanTrigger.CREATE,
        summary: service.name,
      });

      return service;
    });

    return this.detailFor(created.id, userId);
  }

  /**
   * §5.5's edit, where **absent is not empty**.
   *
   * Each array is touched only when the client sent it: `mediaKeys: []` clears the media, omitting
   * it leaves the media alone. A client editing a title must not be able to wipe somebody's
   * photographs by omission, and must not be forced to re-send every array to avoid it.
   */
  async update(
    userId: string,
    listingId: string,
    serviceId: string,
    dto: UpdateServiceDto,
  ): Promise<ServiceView> {
    const listing = await this.assertOwned(userId, listingId);
    const service = await this.owned(serviceId, listing.id);

    const categoryCode = dto.categoryCode ?? service.categoryCode;
    const subcategoryCode =
      dto.subcategoryCode === undefined ? service.subcategoryCode : dto.subcategoryCode;

    if (dto.categoryCode || dto.subcategoryCode !== undefined) {
      await this.assertCategory(categoryCode, subcategoryCode);
    }

    /**
     * The length rule on an edit, and only where the service is a v2 one.
     *
     * A service that already carries a category is being edited by a client that knows v2, so the
     * minimum holds. One without a category is a legacy row whose owner may still be on the old
     * build, and refusing their typo fix over a field the app does not show them would be the same
     * strand in a different place.
     */
    if (dto.description !== undefined && (dto.categoryCode ?? service.categoryCode)) {
      if (dto.description.trim().length < SERVICE_LIMITS.descriptionMin) {
        throw ApiException.unprocessable(
          ApiErrorCode.VALIDATION_FAILED,
          `A service needs at least ${SERVICE_LIMITS.descriptionMin} characters. A one-line offer is not an offer.`,
          {
            details: [
              {
                field: 'description',
                message: `${dto.description.trim().length} characters, minimum ${SERVICE_LIMITS.descriptionMin}.`,
              },
            ],
          },
        );
      }
    }

    /**
     * Re-checked on every edit that touches the category, and on the category it is **moving to**.
     *
     * An edit is how a service would otherwise walk from an ungated category into a regulated one
     * — the create check alone would never see it. The refusal names the category it objects to in
     * `data` for exactly this case: it need not be the one on the member's screen.
     */
    if (categoryCode && (dto.categoryCode || dto.subcategoryCode !== undefined)) {
      await this.verifications.assertMayWrite(userId, categoryCode, subcategoryCode);
    }

    const media =
      dto.mediaKeys === undefined ? null : await this.prepareMedia(userId, dto.mediaKeys);

    await this.database.$transaction(async tx => {
      await tx.professionalService.update({
        where: { id: serviceId },
        data: {
          ...(dto.name === undefined ? {} : { name: dto.name }),
          ...(dto.description === undefined ? {} : { description: dto.description }),
          ...(dto.categoryCode === undefined ? {} : { categoryCode: dto.categoryCode }),
          ...(dto.subcategoryCode === undefined ? {} : { subcategoryCode: dto.subcategoryCode }),
          // Either name, with the v2 one winning where both arrive.
          ...(dto.pricePence === undefined && dto.price === undefined
            ? {}
            : { price: dto.pricePence ?? dto.price }),
          ...(dto.priceBasis === undefined ? {} : { priceBasis: dto.priceBasis }),
          // An older client's only lever (§5.5.1). `false` means hide it; `true` means the owner
          // wants it live, which is not the same as it *being* live.
          ...(dto.isActive === undefined
            ? {}
            : {
                ownerState: dto.isActive ? ServiceOwnerState.LIVE : ServiceOwnerState.HIDDEN,
                isActive: dto.isActive,
              }),
        },
      });

      if (dto.updates !== undefined) {
        await tx.serviceUpdate.deleteMany({ where: { serviceId } });
        await this.writeUpdates(tx, serviceId, dto.updates);
      }

      if (dto.milestones !== undefined) {
        await tx.serviceMilestone.deleteMany({ where: { serviceId } });
        await this.writeMilestones(tx, serviceId, dto.milestones);
      }

      if (media) {
        await this.media.releaseOwner(tx, SERVICE_MEDIA_OWNER, serviceId);
        // The posters go with the set they belonged to. Left behind they would be attached to a
        // video that is no longer here, which is a file nothing renders and nothing collects.
        await this.media.releaseOwner(tx, SERVICE_POSTER_OWNER, serviceId);
        await this.media.attach(tx, media.files, SERVICE_MEDIA_OWNER, serviceId, media.roles);
        await this.media.attachPosters(tx, media.posters, SERVICE_POSTER_OWNER, serviceId);
      }

      if (dto.name !== undefined || dto.description !== undefined) {
        await this.safety.assess(tx, {
          targetType: ReportTargetType.PROFESSIONAL_SERVICE,
          targetId: serviceId,
          authorId: userId,
          fields: {
            name: dto.name ?? service.name,
            description: dto.description ?? service.description,
          },
          trigger: ContentScanTrigger.EDIT,
          summary: dto.name ?? service.name,
        });
      }
    });

    return this.detailFor(serviceId, userId);
  }

  /**
   * §5.5.1: hiding and showing, which is its own route for one reason.
   *
   * **Showing must not override a verification.** A service whose category went back into review
   * returns to `PENDING_VERIFICATION`, not to `PUBLISHED` — and only the server knows which.
   * Setting the owner's intent and deriving the rest is what makes that impossible to get wrong.
   */
  async setVisibility(
    userId: string,
    listingId: string,
    serviceId: string,
    isVisible: boolean,
  ): Promise<ServiceView> {
    const listing = await this.assertOwned(userId, listingId);

    await this.owned(serviceId, listing.id);

    await this.database.professionalService.update({
      where: { id: serviceId },
      data: {
        ownerState: isVisible ? ServiceOwnerState.LIVE : ServiceOwnerState.HIDDEN,
        // Written in step so the older column and the indexes built on it are never wrong.
        isActive: isVisible,
      },
    });

    return this.detailFor(serviceId, userId);
  }

  // ─── Reading ───────────────────────────────────────────────────────────────

  /**
   * The public detail page (§5.6), carrying the professional so one screen is one request.
   *
   * `404` rather than `403` for anything not published, asked for by anybody but its owner.
   */
  async detail(serviceId: string, viewerId?: string): Promise<ServiceView> {
    const view = await this.detailFor(serviceId, viewerId);

    if (!view.viewer.isOwner && !isPublic(view.status)) {
      throw ApiException.notFound('That service could not be found.');
    }

    return view;
  }

  /** One professional's services (§5.6). Published only, unless the owner is asking. */
  async forListing(
    listingId: string,
    viewerId: string | undefined,
    page: { skip: number; take: number; currentPage: number; perPage: number },
  ): Promise<{ data: ServiceView[]; meta: PageMeta }> {
    // visibility: the listing's id and owner, to decide whose view this is. The services below
    // carry the filter, and a held profile hides its services through their own `listing` clause.
    const listing = await this.database.professionalListing.findUnique({
      where: { id: listingId },
      select: { id: true, userId: true },
    });

    if (!listing) throw ApiException.notFound('That profile could not be found.');

    const isOwner = !!viewerId && listing.userId === viewerId;
    const where: Prisma.ProfessionalServiceWhereInput = isOwner
      ? { listingId }
      : {
          listingId,
          ownerState: ServiceOwnerState.LIVE,
          visibilityState: ContentVisibilityState.VISIBLE,
        };

    const [rows, total] = await Promise.all([
      this.database.professionalService.findMany({
        where,
        include: SERVICE_INCLUDE,
        orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.database.professionalService.count({ where }),
    ]);

    const views = await this.toViews(rows, viewerId);

    return {
      // A non-owner never sees a service that is not published, whatever the owner's intent said:
      // the owner-state filter above narrows the query, and this is what applies the gate.
      data: isOwner ? views : views.filter(view => isPublic(view.status)),
      meta: buildPageMeta({ currentPage: page.currentPage, perPage: page.perPage }, total),
    };
  }

  /**
   * §6.2's paged service list — the "see all" behind the blended search.
   *
   * Published services only, which is also what makes the count honest: `meta.totalCount` is the
   * whole argument for tapping through, so it has to be the number of things that are actually
   * there.
   */
  async search(
    query: ListServicesDto,
    viewerId?: string,
  ): Promise<{ data: ServiceView[]; meta: PageMeta }> {
    const where = await this.searchWhere(query);
    const [rows, total] = await Promise.all([
      this.database.professionalService.findMany({
        where,
        include: SERVICE_INCLUDE,
        orderBy: this.order(query),
        skip: query.skip,
        take: query.take,
      }),
      this.database.professionalService.count({ where }),
    ]);
    const views = await this.toViews(rows, viewerId);

    return {
      data: views.filter(view => isPublic(view.status)),
      meta: buildPageMeta({ currentPage: query.currentPage, perPage: query.perPage }, total),
    };
  }

  /** The count and the first rows, for one group of §6.1's blended answer. */
  async group(
    query: ListServicesDto,
    limit: number,
    viewerId?: string,
  ): Promise<{ items: ServiceView[]; totalCount: number }> {
    const where = await this.searchWhere(query);
    const [rows, totalCount] = await Promise.all([
      this.database.professionalService.findMany({
        where,
        include: SERVICE_INCLUDE,
        orderBy: this.order(query),
        take: limit,
      }),
      this.database.professionalService.count({ where }),
    ]);
    const views = await this.toViews(rows, viewerId);

    return { items: views.filter(view => isPublic(view.status)), totalCount };
  }

  /**
   * Which listings have a service matching this text (§6.1).
   *
   * The second half of the search contract: "searching *visa* must surface a person whose services
   * are about visas even if the word is nowhere on their profile."
   */
  async listingIdsMatching(q: string | undefined): Promise<string[] | null> {
    if (!q || q.trim().length < 2) return null;

    const rows = await this.database.professionalService.findMany({
      where: {
        ownerState: ServiceOwnerState.LIVE,
        visibilityState: ContentVisibilityState.VISIBLE,
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: { listingId: true },
      distinct: ['listingId'],
      take: 500,
    });

    return rows.map(row => row.listingId);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async searchWhere(query: ListServicesDto): Promise<Prisma.ProfessionalServiceWhereInput> {
    const text = query.q?.trim();
    const verified = query.verifiedOnly
      ? await this.database.categoryVerification.findMany({
          // Live approvals only: a renewal date that has passed is not a verified filter result.
          where: {
            status: 'APPROVED',
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          select: { userId: true, categoryCode: true },
        })
      : null;

    return {
      ownerState: ServiceOwnerState.LIVE,
      visibilityState: ContentVisibilityState.VISIBLE,
      // A service on a hidden or removed profile is not public either, whatever the service says.
      listing: {
        visibilityState: ContentVisibilityState.VISIBLE,
        deletedAt: null,
        ...(query.cityId ? { cityId: query.cityId } : {}),
        ...(query.minRating
          ? { user: { reputationSummary: { average: { gte: query.minRating } } } }
          : {}),
        ...(verified
          ? { user: { id: { in: [...new Set(verified.map(row => row.userId))] } } }
          : {}),
      },
      ...(query.category ? { categoryCode: query.category } : {}),
      ...(query.subcategory ? { subcategoryCode: query.subcategory } : {}),
      ...(query.maxPricePence ? { price: { lte: query.maxPricePence, not: null } } : {}),
      // Under two characters is ignored, as today: a one-letter search is every row on the
      // platform sorted by nothing.
      ...(text && text.length >= 2
        ? {
            OR: [
              { name: { contains: text, mode: 'insensitive' } },
              { description: { contains: text, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
  }

  /** The sort vocabulary the section already uses. `RELEVANCE` is the default (§6.1). */
  private order(query: ListServicesDto): Prisma.ProfessionalServiceOrderByWithRelationInput[] {
    switch (query.sort) {
      case 'PRICE':
        return [{ price: 'asc' }, { createdAt: 'desc' }];
      case 'RATING':
        return [
          { listing: { user: { reputationSummary: { average: 'desc' } } } },
          { createdAt: 'desc' },
        ];
      case 'REVIEWS':
        return [
          { listing: { user: { reputationSummary: { countedTotal: 'desc' } } } },
          { createdAt: 'desc' },
        ];
      default:
        // `RECOMMENDED` is relevance, with nothing to rank by beyond recency until the search is
        // scored. Stated rather than left to the database's own order, which is no order at all.
        return [{ createdAt: 'desc' }];
    }
  }

  /**
   * The listing's primary category, for a legacy write and for §10's backfill.
   *
   * Null is a real answer: a listing from before categories were required has none, and a service
   * with no category is gated by nothing and renders without the line. Better than refusing
   * somebody's write over a field their client has never heard of.
   */
  private async primaryCategory(listingId: string): Promise<string | null> {
    const rows = await this.database.professionalListingCategory.findMany({
      where: { listingId },
      orderBy: [{ isPrimary: 'desc' }, { code: 'asc' }],
      take: 1,
      select: { code: true },
    });

    return rows[0]?.code ?? null;
  }

  private async assertOwned(userId: string, listingId: string) {
    // visibility: an ownership check before a write. A held listing is still its owner's, and
    // refusing them their own edit would be a moderation decision this is not making.
    const listing = await this.database.professionalListing.findUnique({
      where: { id: listingId },
      select: { id: true, userId: true, deletedAt: true },
    });

    if (!listing || listing.deletedAt)
      throw ApiException.notFound('That profile could not be found.');
    if (listing.userId !== userId) {
      throw ApiException.forbidden(ApiErrorCode.FORBIDDEN, 'That is not your profile.');
    }

    return listing;
  }

  private async owned(serviceId: string, listingId: string) {
    // visibility: the caller's own service, before an edit. Ownership is the question here, and a
    // held service is still editable by the person who wrote it.
    const service = await this.database.professionalService.findUnique({
      where: { id: serviceId },
    });

    if (!service || service.listingId !== listingId) {
      throw ApiException.notFound('That service could not be found.');
    }

    return service;
  }

  /** The category has to exist, be live, and own the subcategory if one was sent (§5.5). */
  private async assertCategory(
    categoryCode: string | null,
    subcategoryCode?: string | null,
  ): Promise<void> {
    if (!categoryCode) return;

    const category = await this.taxonomy.get(TaxonomyKind.PROFESSION, categoryCode);

    if (!category) {
      throw ApiException.unprocessable(
        ApiErrorCode.UNKNOWN_TAXONOMY_CODE,
        'That is not a category we know.',
        { details: [{ field: 'categoryCode', message: 'Unknown category.' }] },
      );
    }

    if (!category.isActive) {
      throw ApiException.unprocessable(
        ApiErrorCode.CATEGORY_RETIRED,
        `${category.label} is no longer offered. Pick the closest one that is.`,
        { details: [{ field: 'categoryCode', message: 'This category has been retired.' }] },
      );
    }

    const children = (await this.taxonomy.list(TaxonomyKind.PROFESSION_SUBCATEGORY)).filter(
      term => (term.metadata as { parentCode?: string } | null)?.parentCode === categoryCode,
    );

    if (!subcategoryCode) {
      if (children.length) {
        throw ApiException.unprocessable(
          ApiErrorCode.SUBCATEGORY_REQUIRED,
          `Choose the kind of ${category.label.toLowerCase()} work this is.`,
          {
            details: [{ field: 'subcategoryCode', message: 'Required for this category.' }],
            data: { categoryCode, subcategories: children.map(child => child.code) },
          },
        );
      }

      return;
    }

    const child = children.find(term => term.code === subcategoryCode);

    if (!child) {
      throw ApiException.unprocessable(
        ApiErrorCode.SUBCATEGORY_MISMATCH,
        'That is not a kind of work in that category.',
        {
          details: [{ field: 'subcategoryCode', message: `Not under ${categoryCode}.` }],
          data: { categoryCode, subcategoryCode },
        },
      );
    }
  }

  /**
   * The media, validated and paired with its roles (§5.5, §9.1).
   *
   * Ten files of which three may be video, and photos and video together — which the general post
   * rules forbid, because a feed card shows one or the other and a service page is built to show
   * both.
   */
  private async prepareMedia(
    userId: string,
    keys: ServiceMediaKeyDto[] | undefined,
  ): Promise<{
    files: Awaited<ReturnType<MediaService['validate']>>;
    roles: Map<string, MediaRole>;
    posters: Map<string, Media>;
  }> {
    if (!keys?.length) return { files: [], roles: new Map(), posters: new Map() };

    const files = await this.media.validate(
      keys.map(entry => entry.key),
      userId,
      SERVICE_MEDIA_RULES,
      'mediaKeys',
    );

    return {
      files,
      roles: new Map(keys.map(entry => [entry.key, entry.role ?? MediaRole.SHOWCASE])),
      // The still frames, validated against the videos they claim to be of before anything is
      // written: a poster paired with a photograph is a client bug, not a thumbnail.
      posters: await this.media.posters(keys, files, userId, 'mediaKeys'),
    };
  }

  private async writeUpdates(
    tx: Prisma.TransactionClient,
    serviceId: string,
    updates: ServiceUpdateDto[] | undefined,
  ): Promise<void> {
    if (!updates?.length) return;

    await tx.serviceUpdate.createMany({
      data: updates.map((update, index) => ({
        serviceId,
        title: update.title ?? null,
        body: update.body,
        sort: index,
      })),
    });
  }

  private async writeMilestones(
    tx: Prisma.TransactionClient,
    serviceId: string,
    milestones: ServiceMilestoneDto[] | undefined,
  ): Promise<void> {
    if (!milestones?.length) return;

    await tx.serviceMilestone.createMany({
      data: milestones.map((milestone, index) => ({
        serviceId,
        label: milestone.label,
        // Null rather than zero, and absent on the way out: "… · 0" is worse than the claim alone.
        year: milestone.year ?? null,
        issuer: milestone.issuer ?? null,
        sort: index,
      })),
    });
  }

  private async detailFor(serviceId: string, viewerId?: string): Promise<ServiceView> {
    /**
     * visibility: read unfiltered on purpose, and filtered by the caller.
     *
     * A single-item read has to tell a held item from a missing one — the owner still sees theirs,
     * with the reason — so the row is fetched and `detail` decides. It answers `404` for anybody
     * else, which is the same answer a missing service gives and so tells a stranger nothing about
     * somebody's pending verification.
     */
    const row = await this.database.professionalService.findUnique({
      where: { id: serviceId },
      include: SERVICE_INCLUDE,
    });

    if (!row) throw ApiException.notFound('That service could not be found.');

    const [view] = await this.toViews([row], viewerId);

    return view;
  }

  /**
   * Rows to views, with the gate resolved in bulk.
   *
   * Three queries for a page of twenty rather than three per row: the categories' gate flags, the
   * professionals' verification states, and the media. A page that asked per row would be sixty
   * queries and a search that got slower the more it found.
   */
  private async toViews(rows: ServiceRow[], viewerId?: string): Promise<ServiceView[]> {
    if (!rows.length) return [];

    const [categories, subcategories, media, ratings] = await Promise.all([
      this.taxonomy.labels(TaxonomyKind.PROFESSION),
      this.taxonomy.labels(TaxonomyKind.PROFESSION_SUBCATEGORY),
      this.database.media.findMany({
        where: { ownerType: SERVICE_MEDIA_OWNER, ownerId: { in: rows.map(row => row.id) } },
        orderBy: { position: 'asc' },
      }),
      this.database.reputationSummary.findMany({
        where: { userId: { in: rows.map(row => row.listing.userId) } },
        select: { userId: true, average: true, countedTotal: true },
      }),
    ]);

    const gateFlags = await this.gateFlags(rows);
    const states = await this.statesFor(rows);
    const notes = await this.notesFor(rows);
    const byRating = new Map(ratings.map(row => [row.userId, row]));

    return rows.map(row => {
      const gated = row.categoryCode
        ? (gateFlags.get(`${row.categoryCode}:${row.subcategoryCode ?? ''}`) ?? false)
        : false;
      const verification: VerificationState = row.categoryCode
        ? (states.get(`${row.listing.userId}:${row.categoryCode}`) ?? 'NOT_SUBMITTED')
        : 'NOT_SUBMITTED';
      const status = statusOf({
        ownerState: row.ownerState,
        visibilityState: row.visibilityState,
        gated,
        verification,
      });
      const rating = byRating.get(row.listing.userId);
      const serviceMedia = media.filter(file => file.ownerId === row.id);

      const professional: ProfessionalRefView = {
        id: row.listing.userId,
        listingId: row.listing.id,
        displayName: [row.listing.user.firstName, row.listing.user.lastName?.slice(0, 1)]
          .filter(Boolean)
          .join(' '),
        avatarUrl: row.listing.photoKey
          ? this.media.sign(row.listing.photoKey)
          : row.listing.user.avatarKey
            ? this.media.sign(row.listing.user.avatarKey)
            : null,
        city: row.listing.city ? { id: row.listing.city.id, name: row.listing.city.name } : null,
        rating: rating?.countedTotal
          ? { average: Number(rating.average ?? 0), count: rating.countedTotal }
          : null,
      };

      return {
        id: row.id,
        listingId: row.listingId,
        name: row.name,
        description: row.description,
        category: row.categoryCode
          ? { code: row.categoryCode, label: categories.get(row.categoryCode) ?? row.categoryCode }
          : null,
        subcategory: row.subcategoryCode
          ? {
              code: row.subcategoryCode,
              label: subcategories.get(row.subcategoryCode) ?? row.subcategoryCode,
            }
          : null,
        price: row.price === null ? null : { amount: row.price, currency: row.currency },
        priceLabel: toPriceLabel(row.price, row.currency),
        status,
        /**
         * Only where the **gate** is what is holding it.
         *
         * Never on a published one, because a client that reads `blockedBy` as "something is
         * wrong" must not find one on a live service — and never where the verification is
         * `APPROVED`, which is the staff-takedown case: a service in a gated category that a
         * moderator removed is `SUSPENDED`, and attaching `verificationStatus: APPROVED` to it
         * reads as "blocked by an approval". That reason lives in the moderation record, and the
         * member hears it through the notice staff sent them.
         */
        blockedBy:
          gated && status !== 'PUBLISHED' && verification !== 'APPROVED' && row.categoryCode
            ? {
                categoryCode: row.categoryCode,
                verificationStatus: verification,
                note: notes.get(`${row.listing.userId}:${row.categoryCode}`) ?? null,
              }
            : null,
        isVerifiedCategory: verification === 'APPROVED',
        media: toMediaViews(serviceMedia, this.media.sign),
        mediaCounts: {
          images: serviceMedia.filter(file => file.type === 'IMAGE').length,
          videos: serviceMedia.filter(file => file.type === 'VIDEO').length,
        },
        updates: row.updates.map(update => ({
          id: update.id,
          title: update.title,
          body: update.body,
          publishedAt: update.publishedAt.toISOString(),
        })),
        milestones: row.milestones.map(milestone => ({
          id: milestone.id,
          label: milestone.label,
          year: milestone.year,
          issuer: milestone.issuer,
        })),
        professional,
        // A field rather than a comparison the client makes (§5.2.1): a row read back from a search
        // carries no user id to compare against, and getting it wrong offers somebody a
        // conversation with themselves.
        viewer: { isOwner: !!viewerId && row.listing.userId === viewerId },
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  /** `category:subcategory` → whether it is gated, for every pair on the page. */
  private async gateFlags(rows: ServiceRow[]): Promise<Map<string, boolean>> {
    const pairs = new Map<string, { category: string; subcategory: string | null }>();

    for (const row of rows) {
      if (!row.categoryCode) continue;

      pairs.set(`${row.categoryCode}:${row.subcategoryCode ?? ''}`, {
        category: row.categoryCode,
        subcategory: row.subcategoryCode,
      });
    }

    const flags = new Map<string, boolean>();

    for (const [key, pair] of pairs) {
      flags.set(key, await this.verifications.isGated(pair.category, pair.subcategory));
    }

    return flags;
  }

  /**
   * `user:category` → the verification state, in one query for the whole page.
   *
   * Through `effectiveStatus`, like every other read of a status: an approval whose renewal date
   * has passed is `EXPIRED` here whether or not the nightly job has reached the column yet. Taking
   * `status` straight off the row made a lapsed approval keep publishing until 03:00.
   */
  private async statesFor(rows: ServiceRow[]): Promise<Map<string, VerificationState>> {
    const records = await this.database.categoryVerification.findMany({
      where: { userId: { in: [...new Set(rows.map(row => row.listing.userId))] } },
      select: { userId: true, categoryCode: true, status: true, expiresAt: true },
    });

    return new Map(records.map(row => [`${row.userId}:${row.categoryCode}`, effectiveStatus(row)]));
  }

  private async notesFor(rows: ServiceRow[]): Promise<Map<string, string | null>> {
    const records = await this.database.categoryVerification.findMany({
      where: { userId: { in: [...new Set(rows.map(row => row.listing.userId))] } },
      select: { userId: true, categoryCode: true, decisionNote: true },
    });

    return new Map(records.map(row => [`${row.userId}:${row.categoryCode}`, row.decisionNote]));
  }
}
