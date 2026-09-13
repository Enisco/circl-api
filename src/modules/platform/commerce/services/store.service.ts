import { Injectable } from '@nestjs/common';
import {
  DealStage,
  DealTrack,
  Prisma,
  Store,
  TaxonomyKind,
  ThreadContextType,
  Weekday,
} from '@prisma/client';
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
import { StaticMapService } from './static-map/static-map.service';
import { CreateStoreDto, StoreContactDto, StoreStatusDto, UpdateStoreDto } from '../dtos/store.dto';
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

/** Below this, `responseRate` is null: one missed message should not read as a bad record. */
const MIN_ENQUIRIES_FOR_RATE = 3;

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
    private readonly staticMap: StaticMapService,
  ) {}

  // ─── 4.1.2 Setup prefill ───────────────────────────────────────────────────

  /** A seller who has been using Circl for six months should not be typing their city and phone number into a store form (4.1). */
  async setupPrefill(userId: string) {
    const [user, store] = await Promise.all([
      this.database.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          avatarKey: true,
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
        // Lets the contact step label the field "from your profile" rather than presenting a mystery prefilled value (4.1.2).
        phoneSource: phoneNumber ? 'PROFILE' : null,
        suggestedHeritageTags: profile?.heritageTag ? [profile.heritageTag] : [],
        // Offered as the starting logo rather than a blank tile.
        suggestedLogoUrl: user.avatarKey ? this.media.sign(user.avatarKey) : user.profileImageUrl,
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
      throw ApiException.conflict(ApiErrorCode.STORE_ALREADY_EXISTS, 'You already have a store.', {
        data: { store: await this.toDetail(existing, userId, null) },
      });
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
      this.singleImage(dto.logoKey, userId),
      this.singleImage(dto.coverKey, userId),
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
          // Stored either way and redacted on read (4.5.1). Erasing it instead meant a seller who
          // hid their address and later unhid it had to type it again, and their own edit form
          // reopened empty in the meantime.
          addressLine1: dto.addressLine1 ?? null,
          postcode: dto.postcode ?? null,
          latitude: dto.latitude ?? city?.latitude ?? null,
          longitude: dto.longitude ?? city?.longitude ?? null,
          delivers: dto.delivers ?? false,
          timezone: city?.timezone ?? 'Europe/London',
          logoKey: logo?.storageKey ?? null,
          coverKey: cover?.storageKey ?? null,
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
    await this.assertOwned(userId, id);

    const city = dto.cityId ? await this.cities.assertValid(dto.cityId) : null;

    await this.validateCodes(dto);

    const contacts = dto.contact ? this.validateContacts(dto.contact) : null;
    const [logo, cover] = await Promise.all([
      this.singleImage(dto.logoKey, userId),
      this.singleImage(dto.coverKey, userId),
    ]);

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

      // An explicit null is "we keep no set hours", which means removing the rows rather than
      // writing seven closed ones. Absent leaves whatever is stored alone.
      if (dto.openingHours === null) {
        await tx.storeOpeningHours.deleteMany({ where: { storeId: id } });
      }

      if (dto.openingHours) {
        await tx.storeOpeningHours.deleteMany({ where: { storeId: id } });
        await tx.storeOpeningHours.createMany({
          data: this.normaliseHours(dto.openingHours).map(row => ({ ...row, storeId: id })),
        });
      }

      if (logo) await this.media.attach(tx, [logo], STORE_LOGO_OWNER, id);
      if (cover) await this.media.attach(tx, [cover], STORE_COVER_OWNER, id);

      // An explicit null is the remove action. Absent is not: a seller editing their opening hours
      // sends neither key, and reading that as null would take their branding with it.
      if (dto.logoKey === null) await this.media.releaseOwner(tx, STORE_LOGO_OWNER, id);
      if (dto.coverKey === null) await this.media.releaseOwner(tx, STORE_COVER_OWNER, id);

      return tx.store.update({
        where: { id },
        data: {
          name: dto.name,
          typeCode: dto.type,
          description: dto.description,
          area: dto.area,
          cityId: city?.id,
          hidesExactAddress: dto.hidesExactAddress,
          ...(dto.addressLine1 !== undefined ? { addressLine1: dto.addressLine1 } : {}),
          ...(dto.postcode !== undefined ? { postcode: dto.postcode } : {}),
          ...(dto.latitude !== undefined ? { latitude: dto.latitude } : {}),
          ...(dto.longitude !== undefined ? { longitude: dto.longitude } : {}),
          delivers: dto.delivers,
          ...(logo ? { logoKey: logo.storageKey } : {}),
          ...(cover ? { coverKey: cover.storageKey } : {}),
          ...(dto.logoKey === null ? { logoKey: null } : {}),
          ...(dto.coverKey === null ? { coverKey: null } : {}),
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
      // Signed at serialisation time; the field names are unchanged.
      logoUrl: store.logoKey ? this.media.sign(store.logoKey) : null,
      coverUrl: store.coverKey ? this.media.sign(store.coverKey) : null,
      // Null when the address is hidden, when there are no coordinates, or when no map provider
      // is configured. The client already renders its placeholder in all three cases (G12).
      staticMapUrl:
        !store.hidesExactAddress && store.staticMapKey ? this.media.sign(store.staticMapKey) : null,
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

  async toDetail(
    store: StoreRow,
    viewerId: string | null,
    origin: { latitude: number; longitude: number } | null,
  ) {
    const summary = await this.toSummary(store, origin);
    const categoryLabels = await this.taxonomy.labels(TaxonomyKind.ITEM_CATEGORY);

    const isOwner = viewerId === store.ownerId;
    const [catalogue, canReview, conversation, ownerStats] = await Promise.all([
      this.database.storeItem.groupBy({
        by: ['categoryCode'],
        where: { storeId: store.id, deletedAt: null },
        _count: { _all: true },
      }),
      viewerId ? this.canReview(viewerId, store) : Promise.resolve(false),
      viewerId
        ? this.database.conversation.findFirst({
            where: {
              // The shop thread when there is one, an item thread with the same shop otherwise:
              // either way the member is sent back to the conversation they already have.
              contextType: { in: ['STORE', 'ITEM'] },
              participants: { some: { userId: viewerId } },
              AND: [{ participants: { some: { userId: store.ownerId } } }],
            },
            orderBy: { contextType: 'desc' },
            select: { id: true },
          })
        : Promise.resolve(null),
      isOwner ? this.ownerStats(store) : Promise.resolve(null),
    ]);

    // Built on the first read that needs it, so a store never waits on a map provider to render
    // and an existing store picks one up without a backfill job.
    this.staticMap.ensure(store);

    return {
      ...summary,
      contact: store.contacts.map(toContactView),
      // Redacted here rather than in the client (4.5.1).
      address: toAddressView(store, viewerId === store.ownerId),
      owner: toAuthorView(store.owner, { sign: this.media.sign }),
      catalogue: {
        categories: catalogue.map(row => ({
          ...toTermView(row.categoryCode, categoryLabels)!,
          itemCount: row._count._all,
        })),
      },
      // The seller's own two counters, and nobody else's business (5).
      ...(ownerStats ?? {}),
      viewer: {
        isOwner,
        canReview,
        conversationId: conversation?.id ?? null,
      },
    };
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * A completed record with this shop that the viewer has not already reviewed. Either a confirmed
   * enquiry, or a deal in a thread with this shop that reached `DONE` — a done deal is the same
   * condition stated in the language the two of them actually used (6).
   */
  private async canReview(viewerId: string, store: Store): Promise<boolean> {
    if (viewerId === store.ownerId) return false;

    const [completed, doneDeal] = await Promise.all([
      this.database.enquiry.findFirst({
        where: { storeId: store.id, buyerId: viewerId, state: 'COMPLETED' },
        select: { id: true },
      }),
      this.database.deal.findFirst({
        where: {
          track: DealTrack.COMMERCE,
          payerId: viewerId,
          providerId: store.ownerId,
          steps: { some: { stage: DealStage.DONE } },
        },
        select: { conversationId: true },
      }),
    ]);

    const sourceIds = [completed?.id, doneDeal?.conversationId].filter(
      (id): id is string => id !== undefined && id !== null,
    );

    if (!sourceIds.length) return false;

    const reviewed = await this.database.review.count({
      where: {
        reviewerId: viewerId,
        context: 'ORDER',
        sourceId: { in: sourceIds },
        deletedAt: null,
      },
    });

    // Unreviewed while any one of their completed records still has a review left in it.
    return reviewed < sourceIds.length;
  }

  /**
   * The seller's own two counters (5). `views` is the store page's own count; `responseRate` is
   * the share of members they ever replied to, null until three of them, so one missed message
   * does not read as a bad record — the same rule the professional's listing uses.
   */
  private async ownerStats(store: Store): Promise<{ views: number; responseRate: number | null }> {
    const [items, enquiries] = await Promise.all([
      this.database.storeItem.findMany({ where: { storeId: store.id }, select: { id: true } }),
      this.database.enquiry.findMany({ where: { storeId: store.id }, select: { id: true } }),
    ]);

    const threads = await this.database.conversation.findMany({
      where: {
        OR: [
          { contextType: ThreadContextType.STORE, contextId: store.id },
          ...(items.length
            ? [{ contextType: ThreadContextType.ITEM, contextId: { in: items.map(row => row.id) } }]
            : []),
          ...(enquiries.length
            ? [
                {
                  contextType: ThreadContextType.ORDER,
                  contextId: { in: enquiries.map(row => row.id) },
                },
              ]
            : []),
        ],
      },
      select: {
        participants: { select: { userId: true } },
        messages: { where: { senderId: store.ownerId }, select: { id: true }, take: 1 },
      },
    });

    // Answered wins over unanswered where the same person did both: the question is whether the
    // seller ever replied to that member at all, not whether every thread got an answer.
    const answeredBy = new Map<string, boolean>();

    for (const thread of threads) {
      const replied = thread.messages.length > 0;

      for (const participant of thread.participants) {
        if (participant.userId === store.ownerId) continue;

        answeredBy.set(
          participant.userId,
          (answeredBy.get(participant.userId) ?? false) || replied,
        );
      }
    }

    const total = answeredBy.size;
    const answered = [...answeredBy.values()].filter(Boolean).length;

    return {
      views: store.viewCount,
      // Integer percent, and null below three.
      responseRate: total < MIN_ENQUIRIES_FOR_RATE ? null : Math.round((answered / total) * 100),
    };
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
      await this.taxonomy.assertAllValid(TaxonomyKind.ITEM_CATEGORY, dto.categories, 'categories');
    }
  }

  /** Contact validation, matching the client exactly (4.8.1). */
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
              {
                details: [{ field: `contact[${index}].channel`, message: 'Unsupported channel.' }],
              },
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
