import { Injectable, Logger } from '@nestjs/common';
import { ApiErrorCode, ApiException, escapeLike } from '@/common';
import { PrismaService } from '@/infrastructure';
import { UserDirectoryService } from '@/modules/core/users/services';
import { GuideService } from '../../community/services/guide.service';
import { GroupService } from '../../community/services/group.service';
import { RequestService } from '../../community/services/request.service';
import { DiscoveryService } from '../../connect/services/discovery.service';
import { CommerceBrowseService } from '../../commerce/services/commerce-browse.service';
import { BrowseService } from '../../professionals/services/browse.service';
import { SearchDto, SearchScope, SearchType, SEARCH_TYPES } from '../dtos/search.dto';
import {
  bestScore,
  CITY_BIAS,
  MIN_TERM_LENGTH,
  normaliseTerm,
  recencyFactor,
  termVariants,
} from './search-terms';

export interface SearchGroup {
  type: SearchType;
  label: string;
  /** The full number of matches, not the number returned. Uncapped: this is what "See all 24" shows. */
  totalCount: number;
  /** @deprecated The same number under its original name. */
  total: number;
  items: unknown[];
  /** Set only when the caller may not search this type. `items` empty, `totalCount` 0. */
  gate?: string;
  /** Set only when this one type timed out or errored. The rest of the response is unaffected. */
  degraded?: boolean;
}

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 25;

/**
 * How many rows a type is asked for before ranking, as a multiple of the requested limit. Ranking
 * happens over this window rather than in SQL, because eight shapes cannot share one ORDER BY.
 * Four is enough for the city bias to have something to choose between and small enough that the
 * hydration each list service does stays trivial.
 */
const OVERFETCH = 4;
const MAX_CANDIDATES = 24;

/**
 * A type that has not answered in this long is dropped from the response rather than allowed to
 * hold the other seven. Search is a keystroke-latency surface: a partial answer now beats a
 * complete one after a second and a half.
 */
const RESOLVER_DEADLINE_MS = 1500;

/**
 * The same member typing, deleting and retyping asks for the same term repeatedly, and going into
 * a result and back asks for it again. Ten seconds is long enough to make all of that free and
 * short enough that a post deleted or a member suspended mid-search disappears while it still
 * feels like the same action.
 *
 * Blocking is the exception and is not left to the clock: the key carries a fingerprint of the
 * caller's blocks, so blocking somebody invalidates every cached answer for that caller at once.
 * "Invisible in every result of every type, in both directions" cannot be eventually true.
 */
const CACHE_TTL_MS = 10_000;
const CACHE_MAX_ENTRIES = 500;

/** A request from eight months ago is almost never useful. A guide from eight months ago usually is. */
const HALF_LIFE_DAYS: Partial<Record<SearchType, number>> = { REQUEST: 45 };

const LABELS: Record<SearchType, string> = {
  REQUEST: 'Requests',
  GUIDE: 'Guides',
  GROUP: 'Groups',
  PERSON: 'People',
  CONNECT_PROFILE: 'Connect',
  PROFESSIONAL: 'Professionals',
  STORE: 'Shops',
  ITEM: 'Items',
};

/** @deprecated Retained so a build sending `scope` keeps working. */
const SCOPE_TYPES: Record<SearchScope, SearchType[]> = {
  ALL: [...SEARCH_TYPES],
  COMMUNITY: ['REQUEST', 'GUIDE', 'GROUP', 'PERSON'],
  PROFESSIONALS: ['PROFESSIONAL'],
  CONNECT: ['CONNECT_PROFILE'],
  COMMERCE: ['STORE', 'ITEM'],
};

interface Candidates {
  total: number;
  items: unknown[];
  gate?: string;
  degraded?: boolean;
}

/**
 * One endpoint, parameterised by `types`, doing exactly one job: the **All** view. A mixed,
 * grouped preview with a true count per type, in one round trip.
 *
 * It takes no filters. The moment a member narrows to a single type the app leaves `/search` and
 * calls that type's own list endpoint, which already has `q`, its own categories, sort and paging.
 * A subcategory is not a shared vocabulary — "Legal" is a request category, a profession code and
 * a store category, three taxonomies that happen to share an English word — so a flat `category=`
 * across a multi-type search would have no single meaning.
 *
 * Latency comes from four decisions, in order of how much they matter:
 *
 * 1. **Every type resolves concurrently**, and one slow or broken type degrades to an empty group
 *    instead of holding the response (`RESOLVER_DEADLINE_MS`).
 * 2. **Every column search reads has a trigram GIN index**, so an `ILIKE '%term%'` is an index
 *    scan rather than a sequential one. `test/e2e/schema-indexes.e2e.cjs` is the guard.
 * 3. **Only `limit x 4` rows are hydrated per type.** Hydration, not matching, is what costs: a
 *    list row carries an author, a city, signed media and taxonomy labels.
 * 4. **Repeat terms are served from a short-lived cache**, which is most of what a search box
 *    actually asks for.
 *
 * Elasticity is two things and neither of them is a second engine. A term is expanded before it
 * reaches SQL, so a plural finds a singular; and matching is substring, so a prefix or an infix
 * both land. `PERSON` adds a trigram pass on top, because names are where typos actually happen.
 */
@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);
  private readonly cache = new Map<string, { at: number; data: unknown }>();

  constructor(
    private readonly database: PrismaService,
    private readonly requests: RequestService,
    private readonly guides: GuideService,
    private readonly groups: GroupService,
    private readonly professionals: BrowseService,
    private readonly connect: DiscoveryService,
    private readonly commerce: CommerceBrowseService,
    private readonly people: UserDirectoryService,
  ) {}

  async search(viewerId: string, dto: SearchDto) {
    const term = normaliseTerm(dto.q);
    const wanted = this.typesFor(dto);
    const limit = Math.min(Math.max(dto.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    // A direct call below two characters is answered, not refused: the client debounces and will
    // not ask, but an empty result is the honest answer to "wh". Nothing reaches the database.
    if (term.length < MIN_TERM_LENGTH || !wanted.length) {
      return { data: { groups: [], suggestions: [] } };
    }

    const key = `${viewerId}|${await this.blockFingerprint(viewerId)}|${term}|${wanted.join(',')}|${limit}|${dto.cityId ?? ''}`;
    const hit = this.cached(key);

    if (hit) return { data: hit };

    // Never below `limit`: the window exists to give ranking something to choose between, and a
    // cap that fell under the requested limit would silently return fewer rows than asked for.
    const take = Math.max(limit, Math.min(limit * OVERFETCH, MAX_CANDIDATES));

    // One round of I/O: every type, the viewer's city and the completions all at once. The city is
    // only needed to rank rows that have already come back, so it never has to be waited on first.
    const [candidates, cityId, suggestions] = await Promise.all([
      Promise.all(wanted.map(type => this.candidatesFor(type, viewerId, term, take))),
      dto.cityId ? Promise.resolve(dto.cityId) : this.viewerCity(viewerId),
      this.suggestions(term, dto.cityId),
    ]);

    const groups = wanted.map((type, index) =>
      this.finalise(type, candidates[index], term, cityId, limit),
    );
    const data = { groups, suggestions };

    this.remember(key, data);

    return { data };
  }

  /**
   * `types` wins, `scope` is honoured when it is all that was sent, and everything is the default.
   * Unknown codes are dropped rather than rejected, so retiring a type never breaks an older build
   * and a new type can ship server-first.
   */
  private typesFor(dto: SearchDto): SearchType[] {
    if (dto.types?.length) {
      const known = new Set<string>(SEARCH_TYPES);
      // Deduped: a repeated code would otherwise mean two identical groups in the response and
      // the same eight queries run twice.
      const asked = new Set(dto.types.filter((code): code is SearchType => known.has(code)));

      return [...asked];
    }

    return SCOPE_TYPES[dto.scope ?? 'ALL'];
  }

  /**
   * Ranking happens here, in memory, over the window the resolver returned. Within a group only:
   * the response is grouped and the app renders groups in its own order, so a global ordering
   * would be computed and then thrown away.
   */
  private finalise(
    type: SearchType,
    candidates: Candidates,
    term: string,
    cityId: string | null,
    limit: number,
  ): SearchGroup {
    const variants = termVariants(term);
    const halfLife = HALF_LIFE_DAYS[type] ?? null;
    const ranked = candidates.items
      .map(item => {
        const row = item as Record<string, unknown>;
        const text = bestScore(headlinesOf(row), variants);
        const bias = cityId && cityIdOf(row) === cityId ? CITY_BIAS : 0;

        return { item, score: (text + bias) * recencyFactor(createdAtOf(row), halfLife) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(entry => stampType(type, entry.item));

    return {
      type,
      label: LABELS[type],
      totalCount: candidates.total,
      total: candidates.total,
      items: ranked,
      ...(candidates.gate ? { gate: candidates.gate } : {}),
      ...(candidates.degraded ? { degraded: true } : {}),
    };
  }

  /**
   * A group is always returned, even empty. The app hides empty groups itself, and a
   * present-but-empty group is how it tells "nothing matched" from "you did not ask for that type".
   */
  private async candidatesFor(
    type: SearchType,
    viewerId: string,
    term: string,
    take: number,
  ): Promise<Candidates> {
    const empty: Candidates = { total: 0, items: [] };

    try {
      return await withDeadline(
        this.resolveElastic(type, viewerId, term, take),
        RESOLVER_DEADLINE_MS,
      );
    } catch (error) {
      // A gate is not a failure, and it must not become a response status: a 403 on the whole call
      // would let one gated type destroy the other seven groups.
      if (error instanceof ApiException && error.code === ApiErrorCode.CONNECT_PROFILE_REQUIRED) {
        return { ...empty, gate: ApiErrorCode.CONNECT_PROFILE_REQUIRED };
      }

      this.logger.warn(`Search group ${type} failed: ${(error as Error).message}`);

      return { ...empty, degraded: true };
    }
  }

  /**
   * The expansion pass. A list endpoint takes one `q` and matches it as a substring, so the stem
   * cannot be ORed into its query without changing six services. Asking a second time costs a
   * query only when the first found nothing at all, which is the only time it can change an
   * answer, and it is what makes "bursaries" find the guide somebody titled "Bursary".
   *
   * `PERSON` is skipped: its resolver already ORs every variant in one query, and has its own
   * trigram fallback below that.
   */
  private async resolveElastic(
    type: SearchType,
    viewerId: string,
    term: string,
    take: number,
  ): Promise<Candidates> {
    const primary = await this.resolve(type, viewerId, term, take);

    if (primary.total > 0 || type === 'PERSON') return primary;

    const stem = termVariants(term)[1];

    return stem ? this.resolve(type, viewerId, stem, take) : primary;
  }

  /**
   * One resolver per type, each owning its own permission rules. Every one returns the row its own
   * list endpoint returns, so the client reuses the parser and the card it already has rather than
   * a shape invented for search.
   *
   * `cityId` is deliberately not passed down: it biases the ranking, it does not filter. A hard
   * city filter would make search feel broken for anyone who has moved recently or is still
   * planning their move, which is a large share of the membership.
   */
  private async resolve(
    type: SearchType,
    viewerId: string,
    term: string,
    take: number,
  ): Promise<Candidates> {
    const query = { q: term, page: 1, limit: take, currentPage: 1, perPage: take, skip: 0, take };
    const paged = async (page: Promise<{ data: unknown[]; meta: { totalCount: number } }>) => {
      const result = await page;

      return { total: result.meta.totalCount, items: result.data };
    };

    switch (type) {
      case 'REQUEST':
        return paged(this.requests.list(viewerId, query as never));
      case 'GUIDE':
        return paged(this.guides.list(viewerId, query as never));
      case 'GROUP':
        return paged(this.groups.list(viewerId, query as never));
      case 'PERSON':
        return this.people.preview(viewerId, term, take, null);
      case 'CONNECT_PROFILE':
        // Facets are a filter bar's worth of work over 500 rows, and search shows no filter bar.
        return paged(this.connect.discover(viewerId, query as never, { facets: false }));
      case 'PROFESSIONAL':
        return paged(this.professionals.browse(viewerId, query as never));
      case 'STORE':
        return paged(this.commerce.browseStores(viewerId, query as never));
      case 'ITEM':
        return paged(this.commerce.browseItems(viewerId, query as never));
    }
  }

  /**
   * Enough of the caller's block list to notice it changed, without reading it. Both directions,
   * and the count moves on an unblock as well as a block. One indexed aggregate.
   */
  private async blockFingerprint(viewerId: string): Promise<string> {
    const summary = await this.database.block.aggregate({
      where: { OR: [{ blockerId: viewerId }, { blockedId: viewerId }] },
      _count: { _all: true },
      _max: { createdAt: true },
    });

    return `${summary._count._all}:${summary._max.createdAt?.getTime() ?? 0}`;
  }

  private async viewerCity(viewerId: string): Promise<string | null> {
    const profile = await this.database.userProfile.findUnique({
      where: { userId: viewerId },
      select: { cityId: true },
    });

    return profile?.cityId ?? null;
  }

  /** Completions drawn from what sellers actually named their items, not a hand-written list. */
  private async suggestions(term: string, cityId?: string): Promise<string[]> {
    const rows = await this.database.storeItem.findMany({
      where: {
        deletedAt: null,
        name: { contains: escapeLike(term), mode: 'insensitive' },
        // Only when the caller named a city. Unlike the groups, a completion the member cannot act
        // on is noise, so this one does filter.
        ...(cityId ? { store: { cityId } } : {}),
      },
      select: { name: true },
      distinct: ['name'],
      take: 5,
    });

    return rows.map(row => row.name);
  }

  private cached(key: string): unknown | null {
    const entry = this.cache.get(key);

    if (!entry) return null;

    if (Date.now() - entry.at > CACHE_TTL_MS) {
      this.cache.delete(key);

      return null;
    }

    return entry.data;
  }

  private remember(key: string, data: unknown): void {
    // Insertion-ordered, so the oldest key is the first one iteration yields. Bounded because an
    // unbounded per-term cache is a memory leak with a search box attached to it.
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next();

      if (!oldest.done) this.cache.delete(oldest.value);
    }

    this.cache.set(key, { at: Date.now(), data });
  }
}

/**
 * Rejects when the work outlives the deadline, which `candidatesFor` turns into an empty group
 * marked `degraded` so one slow type cannot hold the other seven. The work itself is not
 * cancelled, because none of the underlying queries are cancellable: it finishes into a promise
 * nobody is listening to.
 */
const withDeadline = <T>(work: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);

    work.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

/**
 * The type discriminator: an item is the type's ordinary shape plus the fields that say what it
 * is, never a wrapper. A wrapper would mean a second parser per type and a second place for them
 * to drift.
 *
 * Two rows already own a `type` of their own, and it means something else: a Connect profile's is
 * the connection type (FRIENDSHIP, DATING) and a shop's is the shop type (Grocery, Salon).
 * Overwriting either would silently blank a field the card renders, so instead:
 *
 * - `resultType` is **always** the search code, on every item of every type. Dispatch on this, or
 *   on `group.type`, and nothing can collide with it later.
 * - `type` is the search code wherever the row does not already define one, which is six types of
 *   the eight. Where it does, the row keeps its own value and it is mirrored onto `connectionType`
 *   or `storeType` so the client can move off `type` at its own pace.
 *
 * Nothing is lost either way, which is the property worth having.
 */
const OWN_TYPE_ALIAS: Partial<Record<SearchType, string>> = {
  CONNECT_PROFILE: 'connectionType',
  STORE: 'storeType',
};

const stampType = (type: SearchType, item: unknown): Record<string, unknown> => {
  const source = item as Record<string, unknown>;
  const row: Record<string, unknown> = { ...source, resultType: type };
  const own = source.type;

  if (own === undefined || own === type) return { ...row, type };

  const alias = OWN_TYPE_ALIAS[type];

  return alias ? { ...row, [alias]: own } : row;
};

/** The fields worth ranking on. Every shape names its headline differently; this is all of them. */
const headlinesOf = (row: Record<string, unknown>): Array<string | null | undefined> => {
  const user = row?.user as Record<string, unknown> | undefined;
  const values = [
    row?.title,
    row?.name,
    row?.displayName,
    row?.username,
    row?.professionTitle,
    user?.displayName,
    user?.username,
  ];

  return values.map(value => (typeof value === 'string' ? value : null));
};

const cityIdOf = (row: Record<string, unknown>): string | null => {
  const city = (row?.city ?? (row?.store as Record<string, unknown>)?.city) as
    | Record<string, unknown>
    | undefined;
  const id = city?.id ?? row?.cityId;

  return typeof id === 'string' ? id : null;
};

const createdAtOf = (row: Record<string, unknown>): Date | string | null => {
  const value = row?.createdAt ?? row?.postedAt ?? row?.publishedAt;

  return typeof value === 'string' || value instanceof Date ? value : null;
};
