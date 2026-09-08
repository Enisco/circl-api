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

/** Rows fetched per type before ranking: eight shapes cannot share one SQL ORDER BY. */
const OVERFETCH = 4;
const MAX_CANDIDATES = 24;

/** A slow type degrades to an empty group rather than holding the other seven. */
const RESOLVER_DEADLINE_MS = 1500;

/**
 * Retyping the same term is free for ten seconds. Blocking is not left to the clock: the key
 * carries a fingerprint of the caller's blocks, so a block invalidates their cached answers now.
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
 * The All view: a grouped preview with a true count per type, in one round trip. No filters, since
 * narrowing to one type leaves this endpoint for that type's own list. Types resolve concurrently,
 * every searched column has a trigram index, and repeat terms come from a short cache.
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

    // Answered, not refused: an empty result is the honest answer to "wh". No query is run.
    if (term.length < MIN_TERM_LENGTH || !wanted.length) {
      return { data: { groups: [], suggestions: [] } };
    }

    const key = `${viewerId}|${await this.blockFingerprint(viewerId)}|${term}|${wanted.join(',')}|${limit}|${dto.cityId ?? ''}`;
    const hit = this.cached(key);

    if (hit) return { data: hit };

    // Never below `limit`, or the cap would silently return fewer rows than asked for.
    const take = Math.max(limit, Math.min(limit * OVERFETCH, MAX_CANDIDATES));

    // One round of I/O. The city only ranks rows already returned, so it is not waited on first.
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

  /** Unknown codes are dropped, not rejected, so retiring a type never breaks an older build. */
  private typesFor(dto: SearchDto): SearchType[] {
    if (dto.types?.length) {
      const known = new Set<string>(SEARCH_TYPES);
      // Deduped: a repeated code would mean two identical groups and the queries run twice.
      const asked = new Set(dto.types.filter((code): code is SearchType => known.has(code)));

      return [...asked];
    }

    return SCOPE_TYPES[dto.scope ?? 'ALL'];
  }

  /** Ranked in memory, within a group only: the app renders groups in its own order. */
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
      // A gate is a group status, never a response status: a 403 would destroy the other groups.
      if (error instanceof ApiException && error.code === ApiErrorCode.CONNECT_PROFILE_REQUIRED) {
        return { ...empty, gate: ApiErrorCode.CONNECT_PROFILE_REQUIRED };
      }

      this.logger.warn(`Search group ${type} failed: ${(error as Error).message}`);

      return { ...empty, degraded: true };
    }
  }

  /**
   * Retries with the stem when the term found nothing, so "bursaries" finds "Bursary". Skipped for
   * PERSON, whose resolver already ORs every variant and has a trigram fallback.
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
   * One resolver per type, each returning its own list row so the client reuses its parser.
   * `cityId` is not passed down: it biases the ranking, it does not filter.
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
        // Facets read 500 rows for a filter bar search does not show.
        return paged(this.connect.discover(viewerId, query as never, { facets: false }));
      case 'PROFESSIONAL':
        return paged(this.professionals.browse(viewerId, query as never));
      case 'STORE':
        return paged(this.commerce.browseStores(viewerId, query as never));
      case 'ITEM':
        return paged(this.commerce.browseItems(viewerId, query as never));
    }
  }

  /** Enough of the block list to notice it changed, without reading it. One indexed aggregate. */
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
        // This one filters: a completion the member cannot act on is noise.
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
    // Insertion-ordered, so the oldest key goes first. Bounded, or it is a memory leak.
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next();

      if (!oldest.done) this.cache.delete(oldest.value);
    }

    this.cache.set(key, { at: Date.now(), data });
  }
}

/** Rejects past the deadline. The work is not cancelled; it finishes unheard. */
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
 * `resultType` is always the search code. `type` is too, except on the two rows that already own
 * one — a Connect profile's connection type and a shop's shop type — which keep theirs and mirror
 * it onto `connectionType` / `storeType`. Overwriting would blank a field the card renders.
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
