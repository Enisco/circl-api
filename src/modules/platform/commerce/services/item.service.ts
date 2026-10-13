import { Injectable } from '@nestjs/common';
import {
  ActivitySubject,
  ActivityVerb,
  ContentScanTrigger,
  ItemAvailability,
  Media,
  MediaRole,
  MediaType,
  Prisma,
  ReportTargetType,
  TaxonomyKind,
  ThreadContextType,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import {
  ACTIVE_AUTHOR,
  ActivityService,
  ContentSafetyService,
  DIRECT_VISIBILITY,
  isAllCategories,
  isReachable,
  ITEM_MEDIA_RULES,
  MediaService,
  PUBLIC_VISIBILITY,
  TaxonomyService,
  toAuthorView,
  toMediaViews,
  toTermView,
} from '../../shared';
import { ApiErrorCode, ApiException, buildPageMeta, escapeLike, money, Paginated } from '@/common';
import { ItemDto, ListStoreItemsDto, UpdateItemDto } from '../dtos/store.dto';
import { StoreService } from './store.service';

export const ITEM_MEDIA_OWNER = 'STORE_ITEM';

/**
 * What to store for "can somebody buy this". `availability` is the answer; `isAvailable` is the
 * same answer to the narrower question and is written in step, so the older field and every index
 * built on it stay right. Absent leaves both alone.
 *
 * `isAvailable` on its own is still honoured for a client that has not moved yet: `false` means
 * out of stock, which is the only thing that boolean could ever have meant. It can never set a
 * draft, because nothing in it can say so.
 */
const availabilityWrite = (dto: {
  availability?: ItemAvailability;
  isAvailable?: boolean;
}): { availability?: ItemAvailability; isAvailable?: boolean } => {
  if (dto.availability) {
    return {
      availability: dto.availability,
      isAvailable: dto.availability === ItemAvailability.ON_SALE,
    };
  }

  if (dto.isAvailable === undefined) return {};

  return {
    availability: dto.isAvailable ? ItemAvailability.ON_SALE : ItemAvailability.OUT_OF_STOCK,
    isAvailable: dto.isAvailable,
  };
};

@Injectable()
export class ItemService {
  constructor(
    private readonly database: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly media: MediaService,
    private readonly stores: StoreService,
    private readonly activity: ActivityService,
    private readonly safety: ContentSafetyService,
  ) {}

  async create(userId: string, storeId: string, dto: ItemDto) {
    await this.stores.assertOwned(userId, storeId);
    await this.taxonomy.assertValid(TaxonomyKind.ITEM_CATEGORY, dto.categoryCode, 'categoryCode');

    if (dto.unitCode) {
      await this.taxonomy.assertValid(TaxonomyKind.ITEM_UNIT, dto.unitCode, 'unitCode');
    }

    /**
     * `mediaKeys` is v2 §9's shape — photos and video with a role each — and `photoKeys` is what
     * older clients send. Whichever arrives is validated against the same rules; sending both is
     * answered by `mediaKeys`, because it is the one that can express everything the other can.
     */
    const attachments = await this.itemMedia(userId, dto);

    const item = await this.database.$transaction(async tx => {
      const created = await tx.storeItem.create({
        data: {
          storeId,
          name: dto.name,
          description: dto.description ?? null,
          price: dto.price,
          unitCode: dto.unitCode ?? 'EACH',
          unitCustomLabel: dto.unitCustomLabel ?? null,
          categoryCode: dto.categoryCode,
          options: dto.options ?? null,
          ...availabilityWrite(dto),
          sourceDraftId: dto.sourceDraftId ?? null,
        },
      });

      await this.media.attach(
        tx,
        attachments.files,
        ITEM_MEDIA_OWNER,
        created.id,
        attachments.roles,
      );

      // Keeps the store's category hint honest without the seller maintaining it.
      await tx.storeCategory.upsert({
        where: { storeId_code: { storeId, code: dto.categoryCode } },
        update: {},
        create: { storeId, code: dto.categoryCode },
      });

      // An item's name, description and options are what a buyer reads (§6.1).
      await this.safety.assess(tx, {
        targetType: ReportTargetType.STORE_ITEM,
        targetId: created.id,
        authorId: userId,
        fields: {
          name: created.name,
          description: created.description,
          options: created.options,
        },
        mediaKeys: attachments.files.map(file => file.storageKey),
        trigger: ContentScanTrigger.CREATE,
        summary: created.name,
      });

      return created;
    });

    return this.toView(item, attachments.files);
  }

  async update(userId: string, itemId: string, dto: UpdateItemDto) {
    await this.loadOwned(userId, itemId);

    if (dto.categoryCode) {
      await this.taxonomy.assertValid(TaxonomyKind.ITEM_CATEGORY, dto.categoryCode, 'categoryCode');
    }

    if (dto.unitCode) {
      await this.taxonomy.assertValid(TaxonomyKind.ITEM_UNIT, dto.unitCode, 'unitCode');
    }

    // Absent leaves the media alone, `[]` clears it (v2 §9, §5.5's rule): a seller fixing a typo
    // must not lose their photographs by omission.
    const attachments =
      dto.mediaKeys === undefined && dto.photoKeys === undefined
        ? null
        : await this.itemMedia(userId, dto);

    // The set that will be attached once this edit lands, so an edit that does not touch the
    // photos hashes the same (§6.2 step 2).
    const keys = (attachments?.files ?? (await this.media.forOwner(ITEM_MEDIA_OWNER, itemId))).map(
      photo => photo.storageKey,
    );

    const updated = await this.database.$transaction(async tx => {
      if (attachments) {
        await this.media.releaseOwner(tx, ITEM_MEDIA_OWNER, itemId);
        await this.media.attach(tx, attachments.files, ITEM_MEDIA_OWNER, itemId, attachments.roles);
      }

      const patched = await tx.storeItem.update({
        where: { id: itemId },
        data: {
          name: dto.name,
          description: dto.description,
          price: dto.price,
          unitCode: dto.unitCode,
          unitCustomLabel: dto.unitCustomLabel,
          categoryCode: dto.categoryCode,
          options: dto.options,
          // Absent leaves it as it is, which is what every edit that is not about availability
          // wants: a seller fixing a typo should not have to restate whether it is on sale.
          ...availabilityWrite(dto),
        },
      });

      await this.safety.assess(tx, {
        targetType: ReportTargetType.STORE_ITEM,
        targetId: itemId,
        authorId: userId,
        fields: {
          name: patched.name,
          description: patched.description,
          options: patched.options,
        },
        mediaKeys: keys,
        trigger: ContentScanTrigger.EDIT,
        summary: patched.name,
      });

      return patched;
    });

    return this.toView(
      updated,
      attachments?.files ?? (await this.media.forOwner(ITEM_MEDIA_OWNER, itemId)),
    );
  }

  /**
   * An item is never hard-deleted while an enquiry references it, or the enquiry loses its own
   * contents (4.8.3). It is not a refusal: the seller tapped delete, and the item leaves their shop
   * and the marketplace either way — it is kept as a row so somebody's order still says what they
   * ordered. `removed` tells the two apart, and the message says which happened in words a seller
   * can act on.
   */
  async remove(userId: string, itemId: string) {
    const item = await this.loadOwned(userId, itemId);
    const referenced = await this.database.enquiryLine.count({ where: { itemId: item.id } });

    if (referenced > 0) {
      await this.database.storeItem.update({
        where: { id: item.id },
        data: {
          availability: ItemAvailability.OUT_OF_STOCK,
          isAvailable: false,
          deletedAt: new Date(),
        },
      });

      return {
        removed: false,
        delisted: true,
        // Said in words a seller can act on, rather than left for a client to infer from a flag.
        reason:
          'Somebody is still asking about this one, so it has come off the shelf rather than ' +
          'being deleted. Their order still shows what they ordered.',
      };
    }

    await this.database.$transaction(async tx => {
      await this.media.releaseOwner(tx, ITEM_MEDIA_OWNER, item.id);
      await tx.storeItem.delete({ where: { id: item.id } });
    });

    return { removed: true, delisted: true };
  }

  /**
   * The seller's own management screen and a buyer's view of the shop are the same endpoint, so it
   * cannot simply filter drafts out for everybody: the owner is handed theirs and nobody else is.
   */
  async listForStore(
    storeId: string,
    query: ListStoreItemsDto,
    viewerId?: string,
  ): Promise<Paginated<Awaited<ReturnType<ItemService['toView']>>>> {
    // visibility: the shop this catalogue belongs to, for two questions at once — is the caller
    // the shopkeeper, and may this shop be seen at all.
    const store = await this.database.store.findUnique({
      where: { id: storeId },
      select: { ownerId: true, visibilityState: true, deletedAt: true },
    });
    const isOwner = !!viewerId && store?.ownerId === viewerId;

    // A held shop takes its whole catalogue with it. Without this the shop *page* answered 404
    // while this endpoint — the same shelves, one route along — kept serving them (§6.5).
    if (!store || store.deletedAt || (!isOwner && !isReachable(store.visibilityState))) {
      throw ApiException.notFound('That store could not be found.', ApiErrorCode.STORE_NOT_FOUND);
    }

    const where: Prisma.StoreItemWhereInput = {
      // §13.2: an item is only for sale if the person selling it is not suspended.
      store: { owner: ACTIVE_AUTHOR },
      storeId,
      deletedAt: null,
      // A shop page is a direct read, so a limited item is still on the shelf there — but a held
      // one is nobody's to see (§6.5). The shopkeeper sees their own catalogue whole, the same
      // exception the draft rule makes on the line below.
      ...(isOwner ? {} : DIRECT_VISIBILITY),
      // Out of stock stays: it still tells a buyer what the shop sells. A draft is the owner's.
      ...(isOwner ? {} : { availability: { not: ItemAvailability.DRAFT } }),
      ...(query.category && !isAllCategories(query.category)
        ? { categoryCode: query.category }
        : {}),
      ...(query.availableOnly ? { availability: ItemAvailability.ON_SALE } : {}),
      // `%` and `_` are ILIKE wildcards; unescaped, `%` matches the whole table (0.5).
      ...(query.q
        ? { name: { contains: escapeLike(query.q), mode: Prisma.QueryMode.insensitive } }
        : {}),
    };

    const [total, rows] = await this.database.$transaction([
      this.database.storeItem.count({ where }),
      this.database.storeItem.findMany({
        where,
        // `id` last: two items created in the same second would otherwise be free to swap places
        // between page one and page two, showing one twice and the other never.
        // On sale first, then out of stock, then the owner's drafts — which is the order a
        // management screen reads in and the order a shopper wants anyway.
        orderBy: [{ availability: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
        skip: query.skip,
        take: query.take,
      }),
    ]);

    const media = await this.media.forOwners(
      ITEM_MEDIA_OWNER,
      rows.map(row => row.id),
    );
    const views = await Promise.all(rows.map(row => this.toView(row, media.get(row.id) ?? [])));

    return { data: views, meta: buildPageMeta(query, total) };
  }

  async findOne(viewerId: string | null, itemId: string) {
    // visibility: the item the caller has already been allowed to see; the check is below.
    const item = await this.database.storeItem.findUnique({
      where: { id: itemId },
      include: { store: { include: this.stores.storeInclude } },
    });

    if (!item || item.deletedAt) {
      throw ApiException.notFound('That item could not be found.');
    }

    // §6.5: a held item is the shopkeeper's to see and nobody else's.
    if (!isReachable(item.visibilityState) && item.store.ownerId !== viewerId) {
      throw ApiException.notFound('That item could not be found.');
    }

    if (await this.activity.countView('item', itemId, viewerId, item.store.ownerId)) {
      await this.database.storeItem.update({
        where: { id: itemId },
        data: { viewCount: { increment: 1 } },
      });
    }

    this.activity.record({
      userId: viewerId,
      verb: ActivityVerb.VIEW,
      subject: ActivitySubject.STORE_ITEM,
      subjectId: itemId,
      cityId: item.store.cityId,
      code: item.categoryCode,
    });

    const [media, related, storeSummary, conversation] = await Promise.all([
      this.media.forOwner(ITEM_MEDIA_OWNER, itemId),
      // "More from this shop" is a recommendation, so only what anybody may be shown.
      this.database.storeItem.findMany({
        where: {
          storeId: item.storeId,
          id: { not: itemId },
          deletedAt: null,
          store: { owner: ACTIVE_AUTHOR },
          ...PUBLIC_VISIBILITY,
        },
        take: 6,
      }),
      this.stores.toSummary(item.store, null),
      // The thread about this item, so "Ask the seller" opens the conversation they already have
      // rather than a blank one.
      viewerId
        ? this.database.conversation.findFirst({
            where: {
              contextType: ThreadContextType.ITEM,
              contextId: itemId,
              participants: { some: { userId: viewerId } },
            },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);

    const relatedMedia = await this.media.forOwners(
      ITEM_MEDIA_OWNER,
      related.map(row => row.id),
    );

    return {
      ...(await this.toView(item, media)),
      relatedItems: await Promise.all(
        related.map(row => this.toView(row, relatedMedia.get(row.id) ?? [])),
      ),
      store: {
        id: storeSummary.id,
        name: storeSummary.name,
        area: storeSummary.area,
        city: storeSummary.city,
        logoUrl: storeSummary.logoUrl,
        isOpenNow: storeSummary.isOpenNow,
        distanceMiles: storeSummary.distanceMiles,
        rating: storeSummary.rating,
        // "Ask the seller" has no recipient without this, so the button was being hidden rather
        // than shown and broken. The same shared author object the shop detail returns (4.5.1).
        owner: toAuthorView(item.store.owner, { sign: this.media.sign }),
      },
      viewer: {
        isOwner: viewerId === item.store.ownerId,
        conversationId: conversation?.id ?? null,
      },
    };
  }

  /** The photos for a set of items, so a caller building a rail hydrates them in one query. */
  async mediaFor(itemIds: string[]): Promise<Map<string, Media[]>> {
    return this.media.forOwners(ITEM_MEDIA_OWNER, itemIds);
  }

  /**
   * A product's attachments, from either shape the client may send (v2 §9).
   *
   * One validator for both so the limits cannot diverge: ten files, of which three may be video,
   * photos and video together. The general post rules forbid mixing — a feed card draws a gallery
   * or a player, not both — and a product page is built to draw both.
   */
  private async itemMedia(
    userId: string,
    dto: { mediaKeys?: Array<{ key: string; role?: MediaRole }>; photoKeys?: string[] },
  ): Promise<{ files: Media[]; roles: Map<string, MediaRole> }> {
    const keys = dto.mediaKeys?.length
      ? dto.mediaKeys
      : (dto.photoKeys ?? []).map(key => ({ key, role: MediaRole.SHOWCASE }));

    if (!keys.length) return { files: [], roles: new Map() };

    const files = await this.media.validate(
      keys.map(entry => entry.key),
      userId,
      ITEM_MEDIA_RULES,
      dto.mediaKeys?.length ? 'mediaKeys' : 'photoKeys',
    );

    return {
      files,
      roles: new Map(keys.map(entry => [entry.key, entry.role ?? MediaRole.SHOWCASE])),
    };
  }

  async toView(
    item: {
      id: string;
      storeId: string;
      name: string;
      description: string | null;
      price: number;
      currency: string;
      unitCode: string;
      unitCustomLabel: string | null;
      categoryCode: string;
      options: string | null;
      availability: ItemAvailability;
      isAvailable: boolean;
    },
    media: Media[],
  ) {
    const [unitLabels, categoryLabels, store] = await Promise.all([
      this.taxonomy.labels(TaxonomyKind.ITEM_UNIT),
      this.taxonomy.labels(TaxonomyKind.ITEM_CATEGORY),
      // visibility: the shop's name and opening hours, for an item the caller has already been
      // allowed to see.
      this.database.store.findUnique({
        where: { id: item.storeId },
        select: { name: true, status: true, timezone: true },
      }),
    ]);

    const all = toMediaViews(media, this.media.sign);
    /**
     * `photos` stays images-only and unchanged during the transition (v2 §9.2), and `media` is the
     * new array carrying video with its role. Dropping `photos` the moment `media` existed would
     * blank every product on every build that has not shipped yet.
     */
    const photos = all.filter(file => file.type === MediaType.IMAGE);

    return {
      id: item.id,
      storeId: item.storeId,
      storeName: store?.name ?? null,
      name: item.name,
      description: item.description,
      price: money(item.price, item.currency),
      unit: {
        code: item.unitCode,
        // The custom label is the escape hatch for the genuine exceptions the code list does not cover; the code stays filterable either way (D21).
        label: item.unitCustomLabel ?? unitLabels.get(item.unitCode) ?? item.unitCode,
      },
      category: toTermView(item.categoryCode, categoryLabels),
      options: item.options,
      photos,
      media: all,
      mediaCounts: {
        images: photos.length,
        videos: all.filter(file => file.type === MediaType.VIDEO).length,
      },
      // photos[0] promoted to the top level, because every list surface wants exactly one image and should not index into an array to find it (4.4.3).
      coverPhotoUrl: photos[0]?.url ?? null,
      // The same photo as an object, so a square grid can letterbox a tall one instead of cropping
      // the label off it. `width` and `height` are read out of the file itself (0.11.4).
      coverPhoto: photos[0] ?? null,
      availability: item.availability,
      /**
       * @deprecated The same answer to the narrower question. `availability` says which of the two
       * things an unbuyable item is, which a boolean never could.
       */
      isAvailable: item.isAvailable,
    };
  }

  private async loadOwned(userId: string, itemId: string) {
    // visibility: an ownership check before a write. A shopkeeper may edit or delete a held item.
    const item = await this.database.storeItem.findUnique({ where: { id: itemId } });

    if (!item || item.deletedAt) throw ApiException.notFound('That item could not be found.');

    await this.stores.assertOwned(userId, item.storeId);

    return item;
  }
}
