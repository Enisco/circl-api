import { Injectable } from '@nestjs/common';
import { TaxonomyKind } from '@prisma/client';
import { CityService, TaxonomyService, TermRecord } from '../../shared';

export interface CatalogueTerm {
  code: string;
  label: string;
  sort: number;
  isActive: boolean;
  [key: string]: unknown;
}

export interface TaxonomyCatalogue {
  version: string;
  cities: Array<{ id: string; name: string; region: string | null }>;
  communityCategories: CatalogueTerm[];
  professions: CatalogueTerm[];
  guideTopics: CatalogueTerm[];
  countriesOfOrigin: CatalogueTerm[];
  heritageTags: CatalogueTerm[];
  journeyStages: CatalogueTerm[];
  interests: CatalogueTerm[];
  languages: CatalogueTerm[];
  connectionTypes: CatalogueTerm[];
  itemCategories: CatalogueTerm[];
  itemUnits: CatalogueTerm[];
  itemPriceBands: CatalogueTerm[];
  storeTypes: CatalogueTerm[];
  storeContactChannels: CatalogueTerm[];
  storeHelpAreas: CatalogueTerm[];
  helpTags: CatalogueTerm[];
  filters: {
    verification: { isActive: boolean };
    immigrantFriendlyRule: string;
  };
  connect: { minimumAge: number };
}

/** The rule text behind the immigrant-friendly filter (D11). */
export const IMMIGRANT_FRIENDLY_RULE =
  'Has done work for members from other countries and is rated 4 stars or above by them.';

/** Enforced server-side (3.1.2). Sent, not hardcoded, so the gate can change. */
export const CONNECT_MINIMUM_AGE = 18;

/** `GET /api/v1/taxonomy` (spec 0.8). */
@Injectable()
export class TaxonomyCatalogueService {
  constructor(
    private readonly taxonomy: TaxonomyService,
    private readonly cities: CityService,
  ) {}

  async build(): Promise<TaxonomyCatalogue> {
    const [
      version,
      cities,
      communityCategories,
      professions,
      guideTopics,
      countriesOfOrigin,
      heritageTags,
      journeyStages,
      interests,
      languages,
      connectionTypes,
      itemCategories,
      itemUnits,
      itemPriceBands,
      storeTypes,
      storeContactChannels,
      storeHelpAreas,
      helpTags,
    ] = await Promise.all([
      this.taxonomy.version(),
      this.cities.list(),
      // Deactivated terms are returned too, marked `isActive: false`.
      this.taxonomy.list(TaxonomyKind.COMMUNITY_CATEGORY, false),
      this.taxonomy.list(TaxonomyKind.PROFESSION, false),
      this.taxonomy.list(TaxonomyKind.GUIDE_TOPIC, false),
      this.taxonomy.list(TaxonomyKind.COUNTRY_OF_ORIGIN, false),
      this.taxonomy.list(TaxonomyKind.HERITAGE_TAG, false),
      this.taxonomy.list(TaxonomyKind.JOURNEY_STAGE, false),
      this.taxonomy.list(TaxonomyKind.INTEREST, false),
      this.taxonomy.list(TaxonomyKind.LANGUAGE, false),
      this.taxonomy.list(TaxonomyKind.CONNECTION_TYPE, false),
      this.taxonomy.list(TaxonomyKind.ITEM_CATEGORY, false),
      this.taxonomy.list(TaxonomyKind.ITEM_UNIT, false),
      this.taxonomy.list(TaxonomyKind.ITEM_PRICE_BAND, false),
      this.taxonomy.list(TaxonomyKind.STORE_TYPE, false),
      this.taxonomy.list(TaxonomyKind.STORE_CONTACT_CHANNEL, false),
      this.taxonomy.list(TaxonomyKind.STORE_HELP_AREA, false),
      this.taxonomy.list(TaxonomyKind.HELP_TAG, false),
    ]);

    return {
      version: version.toISOString(),
      cities: cities.map(city => ({ id: city.id, name: city.name, region: city.region })),
      communityCategories: communityCategories.map(flatten),
      professions: professions.map(flatten),
      guideTopics: guideTopics.map(flatten),
      countriesOfOrigin: countriesOfOrigin.map(flatten),
      heritageTags: heritageTags.map(flatten),
      journeyStages: journeyStages.map(flatten),
      interests: interests.map(flatten),
      languages: languages.map(flatten),
      connectionTypes: connectionTypes.map(flatten),
      itemCategories: itemCategories.map(flatten),
      itemUnits: itemUnits.map(flatten),
      itemPriceBands: itemPriceBands.map(flatten),
      storeTypes: storeTypes.map(flatten),
      storeContactChannels: storeContactChannels.map(flatten),
      storeHelpAreas: storeHelpAreas.map(flatten),
      helpTags: helpTags.map(flatten),
      filters: {
        // D13: nothing carries a check other than EMAIL this version, so the client hides the filter row.
        verification: { isActive: false },
        immigrantFriendlyRule: IMMIGRANT_FRIENDLY_RULE,
      },
      connect: { minimumAge: CONNECT_MINIMUM_AGE },
    };
  }
}

/** Lifts each kind's `metadata` to the top level, because that is the shape the spec's example payload uses: `isRegulated` and `credentialBodies` sit beside `code` on a profession, not nested under a `metadata` key. */
const flatten = (term: TermRecord): CatalogueTerm => ({
  code: term.code,
  label: term.label,
  sort: term.sort,
  isActive: term.isActive,
  ...(term.description ? { description: term.description } : {}),
  ...(term.metadata ?? {}),
});
