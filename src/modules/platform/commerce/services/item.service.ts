import { Injectable } from '@nestjs/common';
import {
  ActivitySubject,
  ActivityVerb,
  ItemAvailability,
  Media,
  Prisma,
  TaxonomyKind,
  ThreadContextType,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import {
  ActivityService,
  MediaService,
  TaxonomyService,
  toAuthorView,
  toMediaViews,
  toTermView,
  isAllCategories,
} from '../../shared';
import { ApiException, buildPageMeta, escapeLike, money, Paginated } from '@/common';
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
  ) {}

  async create(userId: string, storeId: string, dto: ItemDto) {
    await this.stores.assertOwned(userId, storeId);
    await this.taxonomy.assertValid(TaxonomyKind.ITEM_CATEGORY, dto.categoryCode, 'categoryCode');

    if (dto.unitCode) {
      await this.taxonomy.assertValid(TaxonomyKind.ITEM_UNIT, dto.unitCode, 'unitCode');
    }

    const photos = await this.media.validate(dto.photoKeys, userId, {
      maxImages: 5,
      allowVideo: false,
      allowAudio: false,
    });

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

      await this.media.attach(tx, photos, ITEM_MEDIA_OWNER, created.id);

      // Keeps the store's category hint honest without the seller maintaining it.
      await tx.storeCategory.upsert({
        where: { storeId_code: { storeId, code: dto.categoryCode } },
        update: {},
        create: { storeId, code: dto.categoryCode },
      });

      return created;
    });

    return this.toView(item, photos);
  }

  async update(userId: string, itemId: string, dto: UpdateItemDto) {
    await this.loadOwned(userId, itemId);

    if (dto.categoryCode) {
      await this.taxonomy.assertValid(TaxonomyKind.ITEM_CATEGORY, dto.categoryCode, 'categoryCode');
    }

    if (dto.unitCode) {
      await this.taxonomy.assertValid(TaxonomyKind.ITEM_UNIT, dto.unitCode, 'unitCode');
    }

    const photos = dto.photoKeys
      ? await this.media.validate(dto.photoKeys, userId, {
          maxImages: 5,
          allowVideo: false,
          allowAudio: false,
        })
      : null;

    const updated = await this.database.$transaction(async tx => {
      if (photos) {
        await this.media.releaseOwner(tx, ITEM_MEDIA_OWNER, itemId);
        await this.media.attach(tx, photos, ITEM_MEDIA_OWNER, itemId);
      }

      return tx.storeItem.update({
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
    });

    return this.toView(updated, photos ?? (await this.media.forOwner(ITEM_MEDIA_OWNER, itemId)));
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
    const isOwner = viewerId
      ? (await this.database.store.findFirst({
          where: { id: storeId, ownerId: viewerId },
          select: { id: true },
        })) !== null
      : false;

    const where: Prisma.StoreItemWhereInput = {
      storeId,
      deletedAt: null,
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
    const item = await this.database.storeItem.findUnique({
      where: { id: itemId },
      include: { store: { include: this.stores.storeInclude } },
    });

    if (!item || item.deletedAt) {
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
      this.database.storeItem.findMany({
        where: { storeId: item.storeId, id: { not: itemId }, deletedAt: null },
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
      this.database.store.findUnique({
        where: { id: item.storeId },
        select: { name: true, status: true, timezone: true },
      }),
    ]);

    const photos = toMediaViews(media, this.media.sign);

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
    const item = await this.database.storeItem.findUnique({ where: { id: itemId } });

    if (!item || item.deletedAt) throw ApiException.notFound('That item could not be found.');

    await this.stores.assertOwned(userId, item.storeId);

    return item;
  }
}
