import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/infrastructure';
import { GuideService } from '../../community/services/guide.service';
import { GroupService } from '../../community/services/group.service';
import { RequestService } from '../../community/services/request.service';
import { DiscoveryService } from '../../connect/services/discovery.service';
import { CommerceBrowseService } from '../../commerce/services/commerce-browse.service';
import { BrowseService } from '../../professionals/services/browse.service';
import { SearchDto, SearchScope } from '../dtos/search.dto';

export type SearchGroupType =
  | 'REQUEST'
  | 'GUIDE'
  | 'GROUP'
  | 'PROFESSIONAL'
  | 'CONNECT_PROFILE'
  | 'STORE'
  | 'ITEM';

export interface SearchGroup {
  type: SearchGroupType;
  label: string;
  total: number;
  items: unknown[];
}

/** The shortest term worth running seven queries for. */
const MIN_TERM_LENGTH = 2;
const DEFAULT_LIMIT = 10;

const LABELS: Record<SearchGroupType, string> = {
  REQUEST: 'Requests',
  GUIDE: 'Guides',
  GROUP: 'Groups',
  PROFESSIONAL: 'Professionals',
  CONNECT_PROFILE: 'People',
  STORE: 'Shops',
  ITEM: 'Items',
};

const SCOPE_TYPES: Record<SearchScope, SearchGroupType[]> = {
  ALL: ['REQUEST', 'GUIDE', 'GROUP', 'PROFESSIONAL', 'CONNECT_PROFILE', 'STORE', 'ITEM'],
  COMMUNITY: ['REQUEST', 'GUIDE', 'GROUP'],
  PROFESSIONALS: ['PROFESSIONAL'],
  CONNECT: ['CONNECT_PROFILE'],
  COMMERCE: ['STORE', 'ITEM'],
};

/**
 * One call in place of the four the client used to fan out (G8). Two of the five scope chips —
 * Connect and Commerce — were never searched at all, so selecting either showed an empty state
 * every time, and ranking was client-side and grouped by a fixed type order, so a perfect
 * Commerce match could never outrank a weak guide match.
 *
 * Each group returns the object shape that type's own list endpoint returns, because the client
 * already has a parser and a card for all seven and a bespoke search DTO would mean writing them
 * again.
 */
@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private readonly database: PrismaService,
    private readonly requests: RequestService,
    private readonly guides: GuideService,
    private readonly groups: GroupService,
    private readonly professionals: BrowseService,
    private readonly connect: DiscoveryService,
    private readonly commerce: CommerceBrowseService,
  ) {}

  async search(viewerId: string, dto: SearchDto) {
    const term = dto.q?.trim() ?? '';
    const limit = dto.limit ?? DEFAULT_LIMIT;
    const scope: SearchScope = dto.scope ?? 'ALL';

    // A direct call below two characters is answered, not refused: the client debounces and will
    // not ask, but an empty result is the honest answer to "wh".
    if (term.length < MIN_TERM_LENGTH) {
      return { data: { groups: [], suggestions: [] } };
    }

    const wanted = SCOPE_TYPES[scope];
    const paging = { page: 1, limit, skip: 0, take: limit };
    const common = { q: term, ...(dto.cityId ? { cityId: dto.cityId } : {}), ...paging };

    const settled = await Promise.all(
      wanted.map(type => this.groupFor(type, viewerId, common).catch(error => {
        // One section erroring must not empty the whole result: search is how people find
        // anything, and half an answer beats a 500.
        this.logger.warn(`Search group ${type} failed: ${(error as Error).message}`);

        return null;
      })),
    );

    const groups = settled
      .filter((group): group is SearchGroup => group !== null && group.items.length > 0)
      // Server-decided by relevance rather than a fixed type order, so the strongest match leads.
      .sort((a, b) => this.relevance(b, term) - this.relevance(a, term));

    return { data: { groups, suggestions: await this.suggestions(term, dto.cityId) } };
  }

  private async groupFor(
    type: SearchGroupType,
    viewerId: string,
    query: Record<string, unknown>,
  ): Promise<SearchGroup> {
    const wrap = (total: number, items: unknown[]): SearchGroup => ({
      type,
      label: LABELS[type],
      total,
      items,
    });

    switch (type) {
      case 'REQUEST': {
        const page = await this.requests.list(viewerId, query as never);

        return wrap(page.meta.totalCount, page.data);
      }
      case 'GUIDE': {
        const page = await this.guides.list(viewerId, query as never);

        return wrap(page.meta.totalCount, page.data);
      }
      case 'GROUP': {
        const page = await this.groups.list(viewerId, query as never);

        return wrap(page.meta.totalCount, page.data);
      }
      case 'PROFESSIONAL': {
        const page = await this.professionals.browse(viewerId, query as never);

        return wrap(page.meta.totalCount, page.data);
      }
      case 'CONNECT_PROFILE': {
        const page = await this.connect.discover(viewerId, query as never);

        return wrap(page.meta.totalCount, page.data);
      }
      case 'STORE': {
        const page = await this.commerce.browseStores(viewerId, query as never);

        return wrap(page.meta.totalCount, page.data);
      }
      case 'ITEM': {
        const page = await this.commerce.browseItems(viewerId, query as never);

        return wrap(page.meta.totalCount, page.data);
      }
    }
  }

  /**
   * How strongly a group answers the term. An exact title match anywhere in the group beats a
   * partial one, and a group with more hits beats a thinner one, so "whiting" surfaces the fish
   * before the guide that mentions it once.
   */
  private relevance(group: SearchGroup, term: string): number {
    const needle = term.toLowerCase();
    const best = group.items.reduce<number>((score, item) => {
      const text = titleOf(item).toLowerCase();

      if (!text) return score;
      if (text === needle) return Math.max(score, 3);
      if (text.startsWith(needle)) return Math.max(score, 2);
      if (text.includes(needle)) return Math.max(score, 1);

      return score;
    }, 0);

    // The count breaks ties without ever outweighing a better textual match.
    return best * 100 + Math.min(group.total, 99);
  }

  /** Completions drawn from what sellers actually named their items, not a hand-written list. */
  private async suggestions(term: string, cityId?: string): Promise<string[]> {
    const rows = await this.database.storeItem.findMany({
      where: {
        deletedAt: null,
        name: { contains: term, mode: 'insensitive' },
        ...(cityId ? { store: { cityId } } : {}),
      },
      select: { name: true },
      distinct: ['name'],
      take: 5,
    });

    return rows.map(row => row.name);
  }
}

/** Every list item shape names itself differently; this is the one field they all have some form of. */
const titleOf = (item: unknown): string => {
  const row = item as Record<string, unknown>;
  const candidate =
    row?.title ?? row?.name ?? row?.professionTitle ?? (row?.user as Record<string, unknown>)?.displayName;

  return typeof candidate === 'string' ? candidate : '';
};
