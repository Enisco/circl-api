import { Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { BrowseProfessionalsDto } from '../dtos/browse.dto';
import { ListServicesDto } from '../dtos/service.dto';
import { ServiceView } from '../serializers/service.serializer';
import { BrowseService } from './browse.service';
import { ServiceCatalogueService } from './service-catalogue.service';

/** The two things the search box answers with (v2 §6.1). */
export type SearchGroupType = 'SERVICE' | 'PROFESSIONAL';

export interface SearchGroup<T> {
  type: SearchGroupType;
  items: T[];
  /**
   * The **total match count**, not the number returned (§6.1).
   *
   * It is the whole argument for tapping "See all" — "Services · 124" is what tells somebody that
   * narrowing is worth it — so an approximation would be worse than useless.
   */
  meta: { totalCount: number };
}

/** How many rows each group carries in the blended answer, unless the caller says otherwise. */
const GROUP_LIMIT = 5;

/**
 * The blended search (v2 §6.1): services and professionals, each paged on its own cursor.
 *
 * Deliberately **not** one interleaved list. One list fed by two sources has one scroll position
 * and two cursors, "load more" cannot say which side it advanced, and the moment one side runs out
 * the list quietly changes meaning halfway down. Two groups with their own totals, and narrowing
 * goes to each type's own paged endpoint.
 *
 * It lives in its own service because it is the one place both halves meet: the service catalogue
 * owns services, `BrowseService` owns listings, and neither should have to know about the other to
 * answer its own list.
 */
@Injectable()
export class ProfessionalSearchService {
  constructor(
    private readonly services: ServiceCatalogueService,
    private readonly browse: BrowseService,
  ) {}

  async blended(
    query: ListServicesDto,
    viewerId: string,
    groups?: string,
  ): Promise<{ groups: Array<SearchGroup<ServiceView> | SearchGroup<unknown>> }> {
    const wanted = parseGroups(groups);
    const limit = Math.min(query.perPage, GROUP_LIMIT);
    const answer: Array<SearchGroup<ServiceView> | SearchGroup<unknown>> = [];

    if (wanted.includes('SERVICE')) {
      const { items, totalCount } = await this.services.group(query, limit, viewerId);

      answer.push({ type: 'SERVICE', items, meta: { totalCount } });
    }

    if (wanted.includes('PROFESSIONAL')) {
      /**
       * Professionals whose **services** match the words, which is the point of the feature.
       *
       * "Searching *visa* must surface a person whose services are about visas even if the word is
       * nowhere on their profile." Resolved to listing ids here and handed to the browse query as
       * an argument — not as a query field, which would be refused by the whitelist.
       */
      const alsoListingIds = (await this.services.listingIdsMatching(query.q)) ?? undefined;
      const { data, meta } = await this.browse.browse(viewerId, this.asBrowse(query, limit), {
        alsoListingIds,
      });

      answer.push({ type: 'PROFESSIONAL', items: data, meta: { totalCount: meta.totalCount } });
    }

    return { groups: answer };
  }

  /**
   * The same filters, in the shape the professional list already takes.
   *
   * Mapped rather than re-implemented: narrowing must never silently drop a group, so both halves
   * have to understand `category`, `cityId`, `minRating`, a price ceiling and the sort. The one
   * translation is the price — services carry pence and a listing's `priceFrom` is in pence too,
   * but the browse DTO calls it `maxPrice`.
   */
  private asBrowse(query: ListServicesDto, limit: number): BrowseProfessionalsDto {
    return plainToInstance(BrowseProfessionalsDto, {
      q: query.q,
      category: query.category,
      cityId: query.cityId,
      minRating: query.minRating,
      maxPrice: query.maxPricePence,
      sort: query.sort,
      page: 1,
      limit,
      listingType: 'PROFESSIONAL',
    });
  }
}

/**
 * Which groups to answer with. Both, unless asked for one.
 *
 * An unknown name is ignored rather than refused: the client sends a list it compiled in, and a
 * group this build does not know is one that shipped after it — answering with the ones we do know
 * is more useful than refusing the search.
 */
const parseGroups = (groups?: string): SearchGroupType[] => {
  const asked = (groups ?? '')
    .split(',')
    .map(name => name.trim().toUpperCase())
    .filter((name): name is SearchGroupType => name === 'SERVICE' || name === 'PROFESSIONAL');

  return asked.length ? [...new Set(asked)] : ['SERVICE', 'PROFESSIONAL'];
};
