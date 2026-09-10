import { Injectable } from '@nestjs/common';
import { ActivitySubject, ActivityVerb, Prisma, StoreStatus, TaxonomyKind } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import {
  buildPageMeta,
  daysAgo,
  decodeCursor,
  distanceMiles,
  encodeCursor,
  escapeLike,
} from '@/common';
import {
  ActivityService,
  MediaService,
  TaxonomyService,
  toTermView,
  withoutAllCategories,
} from '../../shared';
import { BrowseCommerceDto } from '../dtos/store.dto';
import { isOpenNow, toOpeningHours } from '../serializers/store.serializer';
import { ItemService, ITEM_MEDIA_OWNER } from './item.service';
import { StoreService } from './store.service';

type ItemSort = NonNullable<BrowseCommerceDto['sort']>;

/**
 * Where the reader had got to: the values the sort actually ordered on, plus the id that breaks
 * every tie. Keyed on values rather than on an offset, so a product added or sold while somebody
 * scrolls moves nothing under them.
 */
interface ItemCursor extends Record<string, unknown> {
  sort: ItemSort;
  id: string;
  isAvailable: boolean;
  viewCount: number;
  price: number;
  createdAt: string;
}

/** The columns each sort orders on, in order, before `id` closes it. */
const SORT_KEYS: Record<ItemSort, Array<{ field: keyof ItemCursor; desc: boolean }>> = {
  RECOMMENDED: [
    { field: 'isAvailable', desc: true },
    { field: 'viewCount', desc: true },
    { field: 'createdAt', desc: true },
  ],
  NEWEST: [{ field: 'createdAt', desc: true }],
  PRICE_LOW: [{ field: 'price', desc: false }],
  PRICE_HIGH: [{ field: 'price', desc: true }],
  // Neither is applied to items, so both fall through to the default ordering.
  NEAREST: [
    { field: 'isAvailable', desc: true },
    { field: 'viewCount', desc: true },
    { field: 'createdAt', desc: true },
  ],
  RATING: [
    { field: 'isAvailable', desc: true },
    { field: 'viewCount', desc: true },
    { field: 'createdAt', desc: true },
  ],
};

const cursorFor = (
  row: { id: string; isAvailable: boolean; viewCount: number; price: number; createdAt: Date },
  query: BrowseCommerceDto,
): ItemCursor => ({
  sort: query.sort ?? 'RECOMMENDED',
  id: row.id,
  isAvailable: row.isAvailable,
  viewCount: row.viewCount,
  price: row.price,
  createdAt: row.createdAt.toISOString(),
});

const valueOf = (cursor: ItemCursor, field: keyof ItemCursor) =>
  field === 'createdAt' ? new Date(cursor.createdAt) : cursor[field];

/**
 * Strictly past the cursor on one key. A two-valued column has to be spelled out rather than
 * compared: past `true` descending is `false`, and past `false` descending is nothing at all —
 * null, so the clause is dropped instead of matching every row on that side.
 */
const beyond = (
  field: keyof ItemCursor,
  cursor: ItemCursor,
  desc: boolean,
): Record<string, unknown> | null => {
  if (field === 'isAvailable') {
    const value = cursor.isAvailable;

    if (desc) return value ? { isAvailable: false } : null;

    return value ? null : { isAvailable: true };
  }

  return { [field]: desc ? { lt: valueOf(cursor, field) } : { gt: valueOf(cursor, field) } };
};

/**
 * Everything strictly after the cursor in the sort's own order: for each key, equal on everything
 * before it and past it here. The last clause is `id`, which is unique, so no row can be both
 * before and after the same cursor.
 */
const after = (cursor: ItemCursor): Prisma.StoreItemWhereInput => {
  const keys = SORT_KEYS[cursor.sort];
  const clauses: Prisma.StoreItemWhereInput[] = keys.flatMap((key, index) => {
    const past = beyond(key.field, cursor, key.desc);

    if (!past) return [];

    return [
      {
        ...Object.fromEntries(
          keys.slice(0, index).map(earlier => [earlier.field, valueOf(cursor, earlier.field)]),
        ),
        ...past,
      },
    ];
  });

  clauses.push({
    ...Object.fromEntries(keys.map(key => [key.field, valueOf(cursor, key.field)])),
    id: { gt: cursor.id },
  });

  return { OR: clauses };
};

@Injectable()
export class CommerceBrowseService {
  constructor(
    private readonly database: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly stores: StoreService,
    private readonly items: ItemService,
    private readonly media: MediaService,
    private readonly activity: ActivityService,
  ) {}

  // ─── 4.4.2 Browse stores ───────────────────────────────────────────────────

  async browseStores(viewerId: string, query: BrowseCommerceDto) {
    this.recordSearch(viewerId, query);

    const where = await this.storeWhere(query, viewerId);
    const origin = this.originOf(query);

    // `openNow` and distance cannot be expressed in SQL — one needs the store's timezone and the current minute, the other needs a coordinate the query does not have.
    const needsPostFilter = Boolean(query.openNow || (origin && query.maxDistanceMiles));

    const [total, rows] = await this.database.$transaction([
      this.database.store.count({ where }),
      this.database.store.findMany({
        where,
        include: this.stores.storeInclude,
        orderBy: this.storeOrder(query),
        skip: needsPostFilter ? 0 : query.skip,
        take: needsPostFilter ? 300 : query.take,
      }),
    ]);

    let summaries = await Promise.all(rows.map(row => this.stores.toSummary(row, origin)));

    if (query.openNow) {
      summaries = summaries.filter(store => store.isOpenNow);
    }

    if (origin && query.maxDistanceMiles) {
      summaries = summaries.filter(
        store => store.distanceMiles !== null && store.distanceMiles <= query.maxDistanceMiles!,
      );
    }

    if (query.sort === 'NEAREST' && origin) {
      summaries.sort((a, b) => (a.distanceMiles ?? Infinity) - (b.distanceMiles ?? Infinity));
    }

    const effectiveTotal = needsPostFilter ? summaries.length : total;
    const page = needsPostFilter ? summaries.slice(query.skip, query.skip + query.take) : summaries;

    return { data: page, meta: buildPageMeta(query, effectiveTotal) };
  }

  private async storeWhere(
    query: BrowseCommerceDto,
    viewerId: string,
  ): Promise<Prisma.StoreWhereInput> {
    const where: Prisma.StoreWhereInput = { deletedAt: null };
    const and: Prisma.StoreWhereInput[] = [];

    if (query.cityId && query.cityId !== 'ANYWHERE') where.cityId = query.cityId;
    if (query.type) where.typeCode = query.type;
    if (query.delivers) where.delivers = true;

    // The "Open now" filter also excludes a store on holiday even before the hours are checked, because its manual status overrides them (4.4.2).
    if (query.openNow) where.status = StoreStatus.OPEN;

    if (query.categories?.length) {
      const known = await this.taxonomy.knownCodes(TaxonomyKind.ITEM_CATEGORY, query.categories);

      and.push({ categories: { some: { code: { in: known.length ? known : ['__NONE__'] } } } });
    }

    if (query.heritage?.length) {
      const known = await this.taxonomy.knownCodes(TaxonomyKind.HERITAGE_TAG, query.heritage);

      and.push({ heritageTags: { some: { code: { in: known.length ? known : ['__NONE__'] } } } });
    }

    if (query.priceBand) {
      const band = await this.taxonomy.get(TaxonomyKind.ITEM_PRICE_BAND, query.priceBand);
      const min = (band?.metadata?.minPence as number | undefined) ?? 0;
      const max = band?.metadata?.maxPence as number | null | undefined;

      // A shop passes if ANYTHING it sells falls in the band.
      and.push({
        items: {
          some: {
            deletedAt: null,
            price: { gte: min, ...(max !== null && max !== undefined ? { lte: max } : {}) },
          },
        },
      });
    }

    if (query.q) {
      // `%` and `_` are ILIKE wildcards; unescaped, `%` matches the whole table (0.5).
      const q = escapeLike(query.q);

      and.push({
        OR: [
          { name: { contains: q, mode: Prisma.QueryMode.insensitive } },
          { description: { contains: q, mode: Prisma.QueryMode.insensitive } },
        ],
      });
    }

    // Your own shop is not a discovery: it has its own screen, and enquiring on it is refused as
    // CANNOT_ENQUIRE_OWN_STORE, so listing it here offers a card whose action cannot work.
    where.ownerId = { not: viewerId };

    if (and.length) where.AND = and;

    return where;
  }

  private storeOrder(query: BrowseCommerceDto): Prisma.StoreOrderByWithRelationInput[] {
    switch (query.sort) {
      case 'NEWEST':
        return [{ createdAt: 'desc' }];
      case 'RATING':
        return [{ owner: { reputationSummary: { average: 'desc' } } }];
      default:
        return [{ enquiryCount: 'desc' }, { createdAt: 'desc' }];
    }
  }

  // ─── 4.4.3 Browse items ────────────────────────────────────────────────────

  async browseItems(viewerId: string, query: BrowseCommerceDto) {
    this.recordSearch(viewerId, query);

    const where: Prisma.StoreItemWhereInput = { deletedAt: null, store: { deletedAt: null } };
    const and: Prisma.StoreItemWhereInput[] = [];

    const categories = withoutAllCategories(query.categories ?? []);

    if (categories.length) {
      const known = await this.taxonomy.knownCodes(TaxonomyKind.ITEM_CATEGORY, categories);

      where.categoryCode = { in: known.length ? known : ['__NONE__'] };
    }

    if (query.priceBand) {
      const band = await this.taxonomy.get(TaxonomyKind.ITEM_PRICE_BAND, query.priceBand);
      const min = (band?.metadata?.minPence as number | undefined) ?? 0;
      const max = band?.metadata?.maxPence as number | null | undefined;

      where.price = { gte: min, ...(max !== null && max !== undefined ? { lte: max } : {}) };
    }

    // Every store-level filter reads through to the item's store (4.4.1).
    const storeFilter: Prisma.StoreWhereInput = { deletedAt: null, ownerId: { not: viewerId } };

    if (query.cityId && query.cityId !== 'ANYWHERE') storeFilter.cityId = query.cityId;
    if (query.type) storeFilter.typeCode = query.type;
    if (query.delivers) storeFilter.delivers = true;
    if (query.openNow) storeFilter.status = StoreStatus.OPEN;

    if (query.heritage?.length) {
      const known = await this.taxonomy.knownCodes(TaxonomyKind.HERITAGE_TAG, query.heritage);

      storeFilter.heritageTags = { some: { code: { in: known.length ? known : ['__NONE__'] } } };
    }

    where.store = storeFilter;

    if (query.q) {
      // `%` and `_` are ILIKE wildcards; unescaped, `%` matches the whole table (0.5).
      const q = escapeLike(query.q);

      and.push({
        OR: [
          { name: { contains: q, mode: Prisma.QueryMode.insensitive } },
          { description: { contains: q, mode: Prisma.QueryMode.insensitive } },
        ],
      });
    }

    // The grid is an infinite scroll, so it pages by cursor: a page number over a list that
    // changes while somebody reads it shows one product twice and hides another (0.5).
    const cursor = decodeCursor<ItemCursor>(query.cursor);
    // A cursor belongs to the query that made it. A different sort means the client started a new
    // list, so serve its first page rather than resuming somebody else's position.
    const resuming = cursor && cursor.sort === (query.sort ?? 'RECOMMENDED') ? cursor : null;

    if (resuming) and.push(after(resuming));

    if (and.length) where.AND = and;

    const [total, rows] = await this.database.$transaction([
      this.database.storeItem.count({ where }),
      this.database.storeItem.findMany({
        where,
        include: { store: { include: this.stores.storeInclude } },
        orderBy: this.itemOrder(query),
        // One more than asked, so "is there another page" is answered rather than guessed.
        ...(resuming ? { take: query.take + 1 } : { skip: query.skip, take: query.take + 1 }),
      }),
    ]);

    const hasMore = rows.length > query.take;

    if (hasMore) rows.pop();

    const origin = this.originOf(query);
    const media = await this.media.forOwners(
      ITEM_MEDIA_OWNER,
      rows.map(row => row.id),
    );

    const views = await Promise.all(
      rows.map(async row => {
        const hours = toOpeningHours(row.store.openingHours);

        return {
          ...(await this.items.toView(row, media.get(row.id) ?? [])),
          distanceMiles: origin ? distanceMiles(origin, row.store) : null,
          storeIsOpenNow: isOpenNow(row.store.status, row.store.timezone, hours),
        };
      }),
    );

    const last = rows[rows.length - 1];

    return {
      data: views,
      meta: buildPageMeta(query, total, {
        // Null at the end of the list, so the client never scrolls off it.
        nextCursor: hasMore && last ? encodeCursor(cursorFor(last, query)) : null,
        hasNextPage: hasMore,
      }),
    };
  }

  /**
   * `id` closes every ordering. The grid pages as the reader scrolls, and two rows the sort cannot
   * separate are otherwise free to swap between requests, which shows one twice and the other not
   * at all.
   */
  private itemOrder(query: BrowseCommerceDto): Prisma.StoreItemOrderByWithRelationInput[] {
    switch (query.sort) {
      case 'PRICE_LOW':
        return [{ price: 'asc' }, { id: 'asc' }];
      case 'PRICE_HIGH':
        return [{ price: 'desc' }, { id: 'asc' }];
      case 'NEWEST':
        return [{ createdAt: 'desc' }, { id: 'asc' }];
      default:
        // RECOMMENDED: in stock first, then what people actually open.
        return [
          { isAvailable: 'desc' },
          { viewCount: 'desc' },
          { createdAt: 'desc' },
          { id: 'asc' },
        ];
    }
  }

  // ─── 4.3 Home ──────────────────────────────────────────────────────────────

  /** Location denied is not an error (4.3): the endpoint works with no coordinates at all, and the "Near me" chip becomes a city picker on the client. */
  async home(viewerId: string, cityId?: string, type?: string) {
    const profile = await this.database.userProfile.findUnique({
      where: { userId: viewerId },
      select: { cityId: true },
    });
    const city = cityId ?? profile?.cityId ?? null;
    const base: Prisma.StoreWhereInput = {
      deletedAt: null,
      // Their own shop comes back as `myStore`, so every rail and every count here is about
      // somebody else's. A category counting one shop and opening on an empty grid is worse than
      // no tile at all.
      ownerId: { not: viewerId },
      ...(city ? { cityId: city } : {}),
      ...(type ? { typeCode: type } : {}),
    };

    // Items, not shops: the front of Commerce is a grid of things for sale, and these two rails are
    // the same shape as `/commerce/items` so the screen needs no second round trip.
    const itemBase: Prisma.StoreItemWhereInput = { deletedAt: null, store: base };

    const [open, popular, newStores, categories, myStore, cityName, popularRows, newRows] =
      await Promise.all([
        this.database.store.findMany({
          where: { ...base, status: StoreStatus.OPEN },
          include: this.stores.storeInclude,
          take: 40,
        }),
        this.database.store.findMany({
          where: base,
          include: this.stores.storeInclude,
          orderBy: { enquiryCount: 'desc' },
          take: 10,
        }),
        this.database.store.findMany({
          where: { ...base, createdAt: { gte: daysAgo(30) } },
          include: this.stores.storeInclude,
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
        this.database.storeCategory.groupBy({
          by: ['code'],
          where: { store: base },
          _count: { _all: true },
        }),
        this.database.store.findUnique({
          where: { ownerId: viewerId },
          select: { id: true, name: true, status: true },
        }),
        city
          ? this.database.city.findUnique({ where: { id: city }, select: { name: true } })
          : null,
        this.database.storeItem.findMany({
          where: { ...itemBase, isAvailable: true },
          orderBy: [{ viewCount: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
          take: 10,
        }),
        this.database.storeItem.findMany({
          where: { ...itemBase, isAvailable: true, createdAt: { gte: daysAgo(30) } },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: 10,
        }),
      ]);

    const itemMedia = await this.items.mediaFor([...popularRows, ...newRows].map(row => row.id));
    const [popularItems, newItems] = await Promise.all([
      Promise.all(popularRows.map(row => this.items.toView(row, itemMedia.get(row.id) ?? []))),
      Promise.all(newRows.map(row => this.items.toView(row, itemMedia.get(row.id) ?? []))),
    ]);

    const [categoryLabels, openSummaries, popularSummaries, newSummaries] = await Promise.all([
      this.taxonomy.labels(TaxonomyKind.ITEM_CATEGORY),
      Promise.all(open.map(store => this.stores.toSummary(store, null))),
      Promise.all(popular.map(store => this.stores.toSummary(store, null))),
      Promise.all(newStores.map(store => this.stores.toSummary(store, null))),
    ]);

    const pendingEnquiryCount = myStore
      ? await this.database.enquiry.count({ where: { storeId: myStore.id, state: 'ACCEPTED' } })
      : 0;

    return {
      openNearYou: openSummaries.filter(store => store.isOpenNow).slice(0, 10),
      popular: popularSummaries,
      // The Intelligence treatment in the UI needs an explanation, so the section carries one rather than implying the ranking is magic (4.3).
      popularReason: cityName
        ? `Most enquiries in ${cityName.name} this week`
        : 'Most enquiries this week',
      newStores: newSummaries,
      // Same shape as an item from `/commerce/items`, so one card renders both.
      popularItems,
      newItems,
      categories: categories
        .map(row => ({ ...toTermView(row.code, categoryLabels)!, storeCount: row._count._all }))
        .sort((a, b) => b.storeCount - a.storeCount),
      // Null for non-sellers, which is what swaps the tab for "Sell on Circl".
      myStore: myStore ? { ...myStore, pendingEnquiryCount } : null,
      // The cart is client-side (D20), so the count comes from the device.
      cart: null,
    };
  }

  /** Circl Intelligence: the demand hint on the Add Item composer (4.8.3). */
  async demandHints(userId: string, storeId: string) {
    const store = await this.stores.assertOwned(userId, storeId);

    const searches = await this.database.activityEvent.groupBy({
      by: ['term'],
      where: {
        verb: ActivityVerb.SEARCH,
        cityId: store.cityId,
        term: { not: null },
        occurredAt: { gte: daysAgo(30) },
      },
      _count: { _all: true },
      orderBy: { _count: { term: 'desc' } },
      take: 20,
    });

    const city = await this.database.city.findUnique({
      where: { id: store.cityId },
      select: { name: true },
    });

    const stocked = await this.database.storeItem.findMany({
      where: { storeId, deletedAt: null },
      select: { name: true },
    });
    const stockedTerms = new Set(stocked.map(item => item.name.toLowerCase()));

    return (
      searches
        // Three searches in a month is not demand.
        .filter(row => row._count._all >= 3 && row.term && !stockedTerms.has(row.term))
        .slice(0, 3)
        .map(row => ({
          term: row.term!,
          searches: row._count._all,
          cityName: city?.name ?? null,
        }))
    );
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private originOf(query: BrowseCommerceDto) {
    return query.latitude !== undefined && query.longitude !== undefined
      ? { latitude: query.latitude, longitude: query.longitude }
      : null;
  }

  /** Every search is a demand signal, which is what feeds the hints above. */
  private recordSearch(viewerId: string, query: BrowseCommerceDto) {
    if (!query.q) return;

    this.activity.record({
      userId: viewerId,
      verb: ActivityVerb.SEARCH,
      subject: ActivitySubject.SEARCH_TERM,
      cityId: query.cityId ?? null,
      term: query.q,
    });
  }
}
