import { Injectable } from '@nestjs/common';
import { Prisma, Store, TaxonomyKind, Weekday } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException, daysAgo } from '@/common';
import {
  CityService,
  MediaService,
  TaxonomyService,
  authorSelect,
  toAuthorView,
  toCityView,
  toTermView,
} from '../../shared';
import { ReputationService } from '../../trust/services/reputation.service';
import {
  CreateStoreDto,
  StoreContactDto,
  StoreStatusDto,
  UpdateStoreDto,
} from '../dtos/store.dto';
import {
  isOpenNow,
  storeDistance,
  toAddressView,
  toContactView,
  toOpeningHours,
} from '../serializers/store.serializer';

export const STORE_LOGO_OWNER = 'STORE_LOGO';
export const STORE_COVER_OWNER = 'STORE_COVER';

/** `isNew` is a server rule so it is defined once (4.4.2). */
const NEW_STORE_DAYS = 30;

const storeInclude = {
  owner: { select: authorSelect },
  city: { select: { id: true, name: true, region: true } },
  openingHours: true,
  contacts: true,
  heritageTags: true,
  categories: true,
} satisfies Prisma.StoreInclude;

type StoreRow = Prisma.StoreGetPayload<{ include: typeof storeInclude }>;

@Injectable()
export class StoreService {
  constructor(
    private readonly database: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly cities: CityService,
    private readonly media: MediaService,
    private readonly reputation: ReputationService,
  ) {}

  // ─── 4.1.2 Setup prefill ───────────────────────────────────────────────────

  /**
   * A seller who has been using Circl for six months should not be typing their
   * city and phone number into a store form (4.1).
   */
  async setupPrefill(userId: string) {
    const [user, store] = await Promise.all([
      this.database.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          profileImageUrl: true,
          profile: {
            select: {
              cityId: true,
              city: { select: { id: true, name: true, region: true } },
              phoneNumber: true,
              phoneNumberDiallingCode: true,
              heritageTag: true,
            },
          },
        },
      }),
      this.database.store.findUnique({ where: { ownerId: userId }, include: storeInclude }),
    ]);

    const profile = user.profile;
    const phoneNumber =
      profile?.phoneNumber && profile.phoneNumberDiallingCode
        ? `${profile.phoneNumberDiallingCode}${profile.phoneNumber}`
        : (profile?.phoneNumber ?? null);

    return {
      store: store ? await this.toDetail(store, userId, null) : null,
      prefill: {
        cityId: profile?.cityId ?? null,
        cityName: profile?.city?.name ?? null,
        phoneNumber,
        // Lets the contact step label the field "from your profile" rather than
        // presenting a mystery prefilled value (4.1.2).
        phoneSource: phoneNumber ? 'PROFILE' : null,
        suggestedHeritageTags: profile?.heritageTag ? [profile.heritageTag] : [],
        // Offered as the starting logo rather than a blank tile.
        suggestedLogoUrl: user.profileImageUrl,
      },
      steps: [
        { key: 'BASICS', status: 'REQUIRED', source: null },
        {
          key: 'WHERE',
          status: profile?.cityId ? 'PREFILLED' : 'REQUIRED',
          source: profile?.cityId ? 'PROFILE_CITY' : null,
        },
        {
          key: 'CONTACT',
          status: phoneNumber ? 'PREFILLED' : 'REQUIRED',
          source: phoneNumber ? 'PROFILE_PHONE' : null,
        },
      ],
    };
  }

  // ─── 4.8.1 Create / patch ──────────────────────────────────────────────────

  async create(userId: string, dto: CreateStoreDto) {
    const existing = await this.database.store.findUnique({
      where: { ownerId: userId },
      include: storeInclude,
    });

    if (existing) {
      throw ApiException.conflict(
        ApiErrorCode.STORE_ALREADY_EXISTS,
        'You already have a store.',
        { data: { store: await this.toDetail(existing, userId, null) } },
      );
    }

    const cityId = dto.cityId ?? (await this.profileCityId(userId));

    if (!cityId) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'We need a city for your store.',
        { details: [{ field: 'cityId', message: 'This is required.' }] },
      );
    }

    await this.cities.assertValid(cityId);
    await this.validateCodes(dto);

    const contacts = this.validateContacts(dto.contact);
    const [logo, cover] = await Promise.all([
      this.singleImage(dto.logoMediaId, userId),
      this.singleImage(dto.coverMediaId, userId),
    ]);
    const city = await this.cities.find(cityId);

    const store = await this.database.$transaction(async tx => {
      const created = await tx.store.create({
        data: {
          ownerId: userId,
          name: dto.name,
          typeCode: dto.type ?? 'LOCAL',
          description: dto.description ?? null,
          area: dto.area,
          cityId,
          hidesExactAddress: dto.hidesExactAddress ?? false,
          // Dropped rather than stored when the seller hides their address, so
          // there is nothing to leak later through a query nobody thought about.
          addressLine1: dto.hidesExactAddress ? null : (dto.addressLine1 ?? null),
          postcode: dto.hidesExactAddress ? null : (dto.postcode ?? null),
          latitude: dto.latitude ?? city?.latitude ?? null,
          longitude: dto.longitude ?? city?.longitude ?? null,
          delivers: dto.delivers ?? false,
          timezone: city?.timezone ?? 'Europe/London',
          logoUrl: logo?.url ?? null,
          coverUrl: cover?.url ?? null,
          heritageTags: { create: (dto.heritageTags ?? []).map(code => ({ code })) },
          categories: { create: (dto.categories ?? []).map(code => ({ code })) },
          contacts: { create: contacts },
          openingHours: { create: this.normaliseHours(dto.openingHours) },
        },
        include: storeInclude,
      });

      if (logo) await this.media.attach(tx, [logo], STORE_LOGO_OWNER, created.id);
      if (cover) await this.media.attach(tx, [cover], STORE_COVER_OWNER, created.id);

      return created;
    });

    return this.toDetail(store, userId, null);
  }

  async update(userId: string, id: string, dto: UpdateStoreDto) {
    const store = await this.assertOwned(userId, id);

    if (dto.cityId) await this.cities.assertValid(dto.cityId);

    await this.validateCodes(dto);

    const contacts = dto.contact ? this.validateContacts(dto.contact) : null;
    const [logo, cover] = await Promise.all([
      this.singleImage(dto.logoMediaId, userId),
      this.singleImage(dto.coverMediaId, userId),
    ]);
    const hidesExactAddress = dto.hidesExactAddress ?? store.hidesExactAddress;

    const updated = await this.database.$transaction(async tx => {
      if (contacts) {
        await tx.storeContact.deleteMany({ where: { storeId: id } });
        await tx.storeContact.createMany({
          data: contacts.map(contact => ({ ...contact, storeId: id })),
        });
      }

      if (dto.heritageTags) {
        await tx.storeHeritageTag.deleteMany({ where: { storeId: id } });
        await tx.storeHeritageTag.createMany({
          data: dto.heritageTags.map(code => ({ storeId: id, code })),
        });
      }

      if (dto.categories) {
        await tx.storeCategory.deleteMany({ where: { storeId: id } });
        await tx.storeCategory.createMany({
          data: dto.categories.map(code => ({ storeId: id, code })),
        });
      }

      if (dto.openingHours) {
        await tx.storeOpeningHours.deleteMany({ where: { storeId: id } });
        await tx.storeOpeningHours.createMany({
          data: this.normaliseHours(dto.openingHours).map(row => ({ ...row, storeId: id })),
        });
      }

      if (logo) await this.media.attach(tx, [logo], STORE_LOGO_OWNER, id);
      if (cover) await this.media.attach(tx, [cover], STORE_COVER_OWNER, id);

      return tx.store.update({
        where: { id },
        data: {
          name: dto.name,
          typeCode: dto.type,
          description: dto.description,
          area: dto.area,
          cityId: dto.cityId,
          hidesExactAddress: dto.hidesExactAddress,
          // Turning the flag on erases what was already stored, rather than
          // leaving it in a column that some future query might select.
          ...(hidesExactAddress
            ? { addressLine1: null, postcode: null }
            : {
                ...(dto.addressLine1 !== undefined ? { addressLine1: dto.addressLine1 } : {}),
                ...(dto.postcode !== undefined ? { postcode: dto.postcode } : {}),
              }),
          ...(dto.latitude !== undefined ? { latitude: dto.latitude } : {}),
          ...(dto.longitude !== undefined ? { longitude: dto.longitude } : {}),
          delivers: dto.delivers,
          ...(logo ? { logoUrl: logo.url } : {}),
          ...(cover ? { coverUrl: cover.url } : {}),
        },
        include: storeInclude,
      });
    });

    return this.toDetail(updated, userId, null);
  }

  /** Separate from the main patch because it is a one-tap action (4.8.2). */
  async setStatus(userId: string, id: string, dto: StoreStatusDto) {
    await this.assertOwned(userId, id);

    const store = await this.database.store.update({
      where: { id },
      data: { status: dto.status },
      include: storeInclude,
    });

    return this.toDetail(store, userId, null);
  }

  // ─── 4.8.4 My store ────────────────────────────────────────────────────────

  async findMine(userId: string) {
    const store = await this.database.store.findUnique({
      where: { ownerId: userId },
      include: storeInclude,
    });

    if (!store || store.deletedAt) {
      // 404 is what the My Store empty state renders against.
      throw ApiException.notFound('You do not have a store yet.', ApiErrorCode.STORE_NOT_FOUND);
    }

    const [pendingEnquiryCount, itemCount] = await Promise.all([
      this.database.enquiry.count({ where: { storeId: store.id, state: 'ACCEPTED' } }),
      this.database.storeItem.count({ where: { storeId: store.id, deletedAt: null } }),
    ]);

    return { ...(await this.toDetail(store, userId, null)), pendingEnquiryCount, itemCount };
  }

  async insights(userId: string) {
    const store = await this.database.store.findUnique({ where: { ownerId: userId } });

    if (!store) {
      throw ApiException.notFound('You do not have a store yet.', ApiErrorCode.STORE_NOT_FOUND);
    }

    const since = daysAgo(30);
    const [enquiries, completed, topItems] = await Promise.all([
      this.database.enquiry.count({ where: { storeId: store.id, createdAt: { gte: since } } }),
      this.database.enquiry.count({
        where: { storeId: store.id, state: 'COMPLETED', createdAt: { gte: since } },
      }),
      this.database.enquiryLine.groupBy({
        by: ['itemId'],
        where: { enquiry: { storeId: store.id, createdAt: { gte: since } }, itemId: { not: null } },
        _sum: { quantity: true },
        orderBy: { _sum: { quantity: 'desc' } },
        take: 5,
      }),
    ]);

    const items = await this.database.storeItem.findMany({
      where: { id: { in: topItems.map(row => row.itemId!).filter(Boolean) } },
      select: { id: true, name: true },
    });
    const names = new Map(items.map(item => [item.id, item.name] as const));

    // No earnings, no payouts, no balances (4.8.4).
    return {
      periodDays: 30,
      views: store.viewCount,
      enquiries,
      completed,
      conversion: store.viewCount ? Number((enquiries / store.viewCount).toFixed(4)) : 0,
      topItems: topItems.map(row => ({
        itemId: row.itemId,
        name: names.get(row.itemId!) ?? 'Removed item',
        quantity: row._sum.quantity ?? 0,
      })),
    };
  }

  // ─── Serialisation ─────────────────────────────────────────────────────────

  async toSummary(store: StoreRow, origin: { latitude: number; longitude: number } | null) {
    const [typeLabels, heritageLabels, categoryLabels, summary, itemPreview] = await Promise.all([
      this.taxonomy.labels(TaxonomyKind.STORE_TYPE),
      this.taxonomy.labels(TaxonomyKind.HERITAGE_TAG),
      this.taxonomy.labels(TaxonomyKind.ITEM_CATEGORY),
      this.reputation.summaryFor(store.ownerId),
      this.database.storeItem.findMany({
        where: { storeId: store.id, deletedAt: null },
        select: { id: true, name: true },
        take: 3,
      }),
    ]);

    const openingHours = toOpeningHours(store.openingHours);

    return {
      id: store.id,
      name: store.name,
      type: toTermView(store.typeCode, typeLabels),
      description: store.description,
      area: store.area,
      city: toCityView(store.city),
      // A number, not "1.1 mi": the client formats and the filter compares (4.4.2).
      distanceMiles: storeDistance(origin, store),
      hidesExactAddress: store.hidesExactAddress,
      heritageTags: store.heritageTags.map(tag => toTermView(tag.code, heritageLabels)),
      categories: store.categories.map(category => toTermView(category.code, categoryLabels)),
      logoUrl: store.logoUrl,
      coverUrl: store.coverUrl,
      rating: { average: summary.average, count: summary.countedTotal },
      isOpenNow: isOpenNow(store.status, store.timezone, openingHours),
      // Sent in full so the client can render "closes 8pm" without a round trip.
      openingHours,
      timezone: store.timezone,
      delivers: store.delivers,
      isNew: store.createdAt >= daysAgo(NEW_STORE_DAYS),
      itemPreview: itemPreview.map(item => ({ id: item.id, name: item.name, photoUrl: null })),
      status: store.status,
    };
  }

  async toDetail(store: StoreRow, viewerId: string | null, origin: { latitude: number; longitude: number } | null) {
    const summary = await this.toSummary(store, origin);
    const categoryLabels = await this.taxonomy.labels(TaxonomyKind.ITEM_CATEGORY);

    const [catalogue, canReview, conversation] = await Promise.all([
      this.database.storeItem.groupBy({
        by: ['categoryCode'],
        where: { storeId: store.id, deletedAt: null },
        _count: { _all: true },
      }),
      viewerId ? this.canReview(viewerId, store) : Promise.resolve(false),
      viewerId
        ? this.database.conversation.findFirst({
            where: {
              contextType: 'ITEM',
              participants: { some: { userId: viewerId } },
              AND: [{ participants: { some: { userId: store.ownerId } } }],
            },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);

    return {
      ...summary,
      contact: store.contacts.map(toContactView),
      // Redacted here rather than in the client (4.5.1).
      address: toAddressView(store),
      owner: toAuthorView(store.owner),
      catalogue: {
        categories: catalogue.map(row => ({
          ...toTermView(row.categoryCode, categoryLabels)!,
          itemCount: row._count._all,
        })),
      },
      viewer: {
        isOwner: viewerId === store.ownerId,
        canReview,
        conversationId: conversation?.id ?? null,
      },
    };
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /** True only when this buyer has a COMPLETED enquiry here and has not reviewed it. */
  private async canReview(viewerId: string, store: Store): Promise<boolean> {
    if (viewerId === store.ownerId) return false;

    const completed = await this.database.enquiry.findFirst({
      where: { storeId: store.id, buyerId: viewerId, state: 'COMPLETED' },
      select: { id: true },
    });

    if (!completed) return false;

    const reviewed = await this.database.review.findFirst({
      where: { reviewerId: viewerId, context: 'ORDER', sourceId: completed.id, deletedAt: null },
      select: { id: true },
    });

    return reviewed === null;
  }

  private async validateCodes(dto: CreateStoreDto | UpdateStoreDto): Promise<void> {
    if (dto.type) await this.taxonomy.assertValid(TaxonomyKind.STORE_TYPE, dto.type, 'type');

    if (dto.heritageTags?.length) {
      await this.taxonomy.assertAllValid(
        TaxonomyKind.HERITAGE_TAG,
        dto.heritageTags,
        'heritageTags',
      );
    }

    if (dto.categories?.length) {
      await this.taxonomy.assertAllValid(
        TaxonomyKind.ITEM_CATEGORY,
        dto.categories,
        'categories',
      );
    }
  }

  /**
   * Contact validation, matching the client exactly (4.8.1).
   *
   * An empty field is not an error — only what was actually typed is validated,
   * which is what lets a seller publish with only a WhatsApp number. A store with
   * no contact channel at all is allowed and reachable through Circl chat.
   */
  private validateContacts(contacts: StoreContactDto[] | undefined) {
    if (!contacts?.length) return [];

    return contacts
      .filter(contact => contact.value.trim().length > 0)
      .map((contact, index) => {
        const field = `contact[${index}].value`;
        const raw = contact.value.trim();

        switch (contact.channel) {
          case 'PHONE':
          case 'WHATSAPP': {
            const digits = raw.replace(/\D/g, '');

            if (digits.length < 7) {
              throw ApiException.unprocessable(
                ApiErrorCode.VALIDATION_FAILED,
                'Enter a valid phone number.',
                { details: [{ field, message: 'Needs at least 7 digits.' }] },
              );
            }

            return { channel: contact.channel, value: raw.replace(/[^\d+]/g, '') };
          }

          case 'INSTAGRAM':
          case 'TIKTOK': {
            // Stored without the @, displayed with one.
            const handle = raw.replace(/^@+/, '').trim();

            if (!handle) {
              throw ApiException.unprocessable(
                ApiErrorCode.VALIDATION_FAILED,
                'Enter a valid handle.',
                { details: [{ field, message: 'Enter a handle.' }] },
              );
            }

            return { channel: contact.channel, value: handle };
          }

          case 'WEBSITE': {
            if (!raw.includes('.')) {
              throw ApiException.unprocessable(
                ApiErrorCode.VALIDATION_FAILED,
                'Enter a valid website.',
                { details: [{ field, message: 'That does not look like a website.' }] },
              );
            }

            return { channel: contact.channel, value: raw };
          }

          default:
            throw ApiException.unprocessable(
              ApiErrorCode.UNKNOWN_TAXONOMY_CODE,
              `"${contact.channel}" is not a contact channel we support.`,
              { details: [{ field: `contact[${index}].channel`, message: 'Unsupported channel.' }] },
            );
        }
      });
  }

  private normaliseHours(hours: CreateStoreDto['openingHours']) {
    if (!hours?.length) return [];

    return hours.map(row => ({
      day: row.day as Weekday,
      openMinutes: row.openMinutes ?? null,
      closeMinutes: row.closeMinutes ?? null,
    }));
  }

  private async singleImage(mediaId: string | undefined, userId: string) {
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

  async assertOwned(userId: string, id: string): Promise<Store> {
    const store = await this.database.store.findUnique({ where: { id } });

    if (!store || store.deletedAt) {
      throw ApiException.notFound('That store could not be found.', ApiErrorCode.STORE_NOT_FOUND);
    }

    if (store.ownerId !== userId) {
      throw ApiException.forbidden(ApiErrorCode.FORBIDDEN, 'This is not your store.');
    }

    return store;
  }

  /** Loads a store for public viewing, with everything the profile renders. */
  async storeOrThrow(id: string): Promise<StoreRow> {
    const store = await this.database.store.findUnique({ where: { id }, include: storeInclude });

    if (!store || store.deletedAt) {
      throw ApiException.notFound('That store could not be found.', ApiErrorCode.STORE_NOT_FOUND);
    }

    await this.database.store.update({ where: { id }, data: { viewCount: { increment: 1 } } });

    return store;
  }

  storeInclude = storeInclude;
}
