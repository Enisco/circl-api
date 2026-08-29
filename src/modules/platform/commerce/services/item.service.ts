import { Injectable } from '@nestjs/common';
import { ActivitySubject, ActivityVerb, Media, Prisma, TaxonomyKind } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import {
  ActivityService,
  MediaService,
  TaxonomyService,
  toMediaViews,
  toTermView,
} from '../../shared';
import { ApiException, buildPageMeta, money, Paginated } from '@/common';
import { ItemDto, ListStoreItemsDto, UpdateItemDto } from '../dtos/store.dto';
import { StoreService } from './store.service';

export const ITEM_MEDIA_OWNER = 'STORE_ITEM';

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
          isAvailable: dto.isAvailable ?? true,
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
          isAvailable: dto.isAvailable,
        },
      });
    });

    return this.toView(updated, photos ?? (await this.media.forOwner(ITEM_MEDIA_OWNER, itemId)));
  }

  /** An item is never hard-deleted while an open enquiry references it, or the enquiry loses its own contents (4.8.3). */
  async remove(userId: string, itemId: string) {
    const item = await this.loadOwned(userId, itemId);
    const referenced = await this.database.enquiryLine.count({ where: { itemId: item.id } });

    if (referenced > 0) {
      await this.database.storeItem.update({
        where: { id: item.id },
        data: { isAvailable: false, deletedAt: new Date() },
      });

      return { removed: false, delisted: true };
    }

    await this.database.$transaction(async tx => {
      await this.media.releaseOwner(tx, ITEM_MEDIA_OWNER, item.id);
      await tx.storeItem.delete({ where: { id: item.id } });
    });

    return { removed: true, delisted: true };
  }

  async listForStore(
    storeId: string,
    query: ListStoreItemsDto,
  ): Promise<Paginated<Awaited<ReturnType<ItemService['toView']>>>> {
    const where: Prisma.StoreItemWhereInput = {
      storeId,
      deletedAt: null,
      ...(query.category ? { categoryCode: query.category } : {}),
      ...(query.availableOnly ? { isAvailable: true } : {}),
      ...(query.q ? { name: { contains: query.q, mode: Prisma.QueryMode.insensitive } } : {}),
    };

    const [total, rows] = await this.database.$transaction([
      this.database.storeItem.count({ where }),
      this.database.storeItem.findMany({
        where,
        orderBy: [{ isAvailable: 'desc' }, { createdAt: 'desc' }],
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

    const [media, related, storeSummary] = await Promise.all([
      this.media.forOwner(ITEM_MEDIA_OWNER, itemId),
      this.database.storeItem.findMany({
        where: { storeId: item.storeId, id: { not: itemId }, deletedAt: null },
        take: 6,
      }),
      this.stores.toSummary(item.store, null),
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
      },
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
