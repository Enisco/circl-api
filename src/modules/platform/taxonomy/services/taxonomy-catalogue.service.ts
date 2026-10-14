import { Injectable } from '@nestjs/common';
import { TaxonomyKind } from '@prisma/client';
import { createHash } from 'crypto';
import { SYSTEM_CONFIG_KEYS } from '@/common';
import { CityService, SystemConfigService, TaxonomyService, TermRecord } from '../../shared';
import { SERVICE_LIMITS } from '../../professionals/dtos/service.dto';

export interface CatalogueTerm {
  code: string;
  label: string;
  sort: number;
  isActive: boolean;
  [key: string]: unknown;
}

export interface TaxonomyCatalogue {
  version: string;
  cities: Array<{ id: string; label: string; name: string; region: string | null }>;
  communityCategories: CatalogueTerm[];
  /**
   * The professional categories, each carrying its own `subcategories` (v2 §3.1).
   *
   * Extending this key rather than adding a parallel one, because every client already parses it
   * and a second key would mean two vocabularies for one shelf.
   */
  professions: CatalogueTerm[];
  /** What a professional does, tagged by the categories it belongs to (v2 §3.4). */
  skills: CatalogueTerm[];
  guideTopics: CatalogueTerm[];
  heritageTags: CatalogueTerm[];
  journeyStages: CatalogueTerm[];
  interests: CatalogueTerm[];
  /**
   * What somebody is *into*, for the Connect profile. Deliberately not `interests`, whose first
   * fifteen codes are community categories so the feed ranker can match a post against them.
   */
  hobbies: CatalogueTerm[];
  languages: CatalogueTerm[];
  connectionTypes: CatalogueTerm[];
  /** The questions a Connect profile answers. `label` is the question itself (3.3.1). */
  connectPrompts: CatalogueTerm[];
  itemCategories: CatalogueTerm[];
  itemUnits: CatalogueTerm[];
  itemPriceBands: CatalogueTerm[];
  storeTypes: CatalogueTerm[];
  storeContactChannels: CatalogueTerm[];
  storeHelpAreas: CatalogueTerm[];
  helpTags: CatalogueTerm[];
  genders: CatalogueTerm[];
  managedCategories: CatalogueTerm[];
  experienceLevels: CatalogueTerm[];
  urgencyOptions: CatalogueTerm[];
  privateHelpCategories: CatalogueTerm[];
  spokenLanguages: CatalogueTerm[];
  connectAgeBands: CatalogueTerm[];
  professionalSortOptions: CatalogueTerm[];
  feedTypes: CatalogueTerm[];
  requestStatuses: CatalogueTerm[];
  commerceSortOptions: CatalogueTerm[];
  limits: TaxonomyLimits;
  filters: {
    verification: { isActive: boolean };
    immigrantFriendlyRule: string;
  };
  connect: { minimumAge: number };
}

/** Numbers the app used to compile in, which only the server can be right about. */
export interface TaxonomyLimits {
  maxInterests: number;
  maxLanguages: number;
  minConnectAge: number;
  nearMeRadiusMiles: number;
  /** HOBBY codes on a Connect profile. */
  maxHobbies: number;
  /**
   * How many a profile needs **to be created** (v2 §2).
   *
   * The card is the reason: hobbies are what a stranger taps to start a conversation, so one
   * hobby offers one way in. On create only, like `minConnectPhotos` — a member who joined before
   * the rule can still fix a typo without being asked to pick two more.
   */
  minHobbies: number;
  /**
   * How many photographs a member may pick as their card (v2 §1).
   *
   * The card is what Browse and the deck draw, and before this the only lever was post order — so
   * a member whose three favourite photographs were spread across three posts could not have them
   * as their card at all.
   */
  maxCardPhotos: number;
  /**
   * Photos a Connect profile needs **to be created**. One photo reads as low effort and leaves
   * the card's swipe gesture with nothing to do.
   *
   * On create, never on edit: a member who joined Connect before the rule keeps their place, and
   * an edit that demanded two more pictures first would lock them out of their own profile.
   */
  minConnectPhotos: number;
  /** A prompt answer is a sentence on a card, not a paragraph. */
  minPromptAnswer: number;
  maxPromptAnswer: number;

  // ── Professionals v2 (§3.5). The numbers the app enforces in the form, sent so a change to any
  // of them needs no release.
  maxListingCategories: number;
  /**
   * How many services one profile may hold.
   *
   * Asked for by §8 — "if you cap services per listing, tell us the number" — and then asked for
   * again once it was clear the client was holding thirty of its own: a limit the form enforces and
   * the server also enforces, from two places, is one number until somebody changes one of them.
   */
  maxServicesPerListing: number;
  maxServiceMedia: number;
  maxServiceVideos: number;
  minServiceDescription: number;
  maxServiceDescription: number;
  maxServiceUpdates: number;
  maxServiceMilestones: number;
  maxSkills: number;
  maxCustomSkills: number;
  maxSkillLabel: number;
  maxVerificationDocuments: number;
  /** Marketplace (§9): videos per product, and what one may weigh. */
  maxItemPhotos: number;
  maxItemVideos: number;
  /**
   * Sixty seconds and fifty megabytes, which is the number they asked us to pick.
   *
   * The shopper on a 3G connection is who pays for a four-minute 4K clip somebody uploaded from a
   * phone, and they pay for it before they can see whether they wanted it.
   */
  maxVideoSeconds: number;
  maxVideoBytes: number;
}

/** The rule text behind the immigrant-friendly filter (D11). */
export const IMMIGRANT_FRIENDLY_RULE =
  'Has done work for members from other countries and is rated 4 stars or above by them.';

/** Enforced server-side (3.1.2). Sent, not hardcoded, so the gate can change. */
export const CONNECT_MINIMUM_AGE = 18;

/**
 * The four the client had compiled in. They are the server's rules, so if the server later
 * refuses a ninth interest the app has to have been able to know that without a release.
 */
export const TAXONOMY_LIMITS: TaxonomyLimits = {
  maxInterests: 8,
  maxLanguages: 6,
  minConnectAge: CONNECT_MINIMUM_AGE,
  nearMeRadiusMiles: 5,
  maxHobbies: 8,
  minHobbies: 3,
  maxCardPhotos: 3,
  minConnectPhotos: 3,
  minPromptAnswer: 20,
  maxPromptAnswer: 100,
  maxListingCategories: 3,
  // Read from the DTO's own constant rather than restated, so the number the form is told and the
  // number the write refuses on cannot drift apart.
  maxServicesPerListing: SERVICE_LIMITS.perListing,
  maxServiceMedia: 10,
  maxServiceVideos: 3,
  minServiceDescription: 40,
  maxServiceDescription: 1500,
  maxServiceUpdates: 10,
  maxServiceMilestones: 6,
  maxSkills: 10,
  maxCustomSkills: 3,
  maxSkillLabel: 30,
  maxVerificationDocuments: 5,
  // Unchanged by v2, and stated because the video limit beside it would otherwise read as the
  // whole rule for a product's media.
  maxItemPhotos: 5,
  maxItemVideos: 3,
  maxVideoSeconds: 60,
  maxVideoBytes: 50 * 1024 * 1024,
};

/**
 * The four served from `system_config` rather than from the constant above, so staff can move them
 * without a release — which is what the client was promised when it was told to stop compiling
 * them in. The constant is the default; a stored row is an override.
 *
 * They are also the four that are **enforced** from config, in `ConnectProfileService`. A limit
 * the payload advertises and the service does not read is a number that lies to the client the
 * moment somebody changes it.
 */
export const configuredLimits = async (
  config: SystemConfigService,
): Promise<
  Pick<
    TaxonomyLimits,
    | 'maxHobbies'
    | 'minHobbies'
    | 'maxCardPhotos'
    | 'minConnectPhotos'
    | 'minPromptAnswer'
    | 'maxPromptAnswer'
  >
> => {
  const stored = await config.getMany(
    SYSTEM_CONFIG_KEYS.MAX_HOBBIES,
    SYSTEM_CONFIG_KEYS.MIN_HOBBIES,
    SYSTEM_CONFIG_KEYS.MAX_CARD_PHOTOS,
    SYSTEM_CONFIG_KEYS.MIN_CONNECT_PHOTOS,
    SYSTEM_CONFIG_KEYS.MIN_PROMPT_ANSWER,
    SYSTEM_CONFIG_KEYS.MAX_PROMPT_ANSWER,
  );

  return {
    maxHobbies: stored[SYSTEM_CONFIG_KEYS.MAX_HOBBIES],
    minHobbies: stored[SYSTEM_CONFIG_KEYS.MIN_HOBBIES],
    maxCardPhotos: stored[SYSTEM_CONFIG_KEYS.MAX_CARD_PHOTOS],
    minConnectPhotos: stored[SYSTEM_CONFIG_KEYS.MIN_CONNECT_PHOTOS],
    minPromptAnswer: stored[SYSTEM_CONFIG_KEYS.MIN_PROMPT_ANSWER],
    maxPromptAnswer: stored[SYSTEM_CONFIG_KEYS.MAX_PROMPT_ANSWER],
  };
};

/** `GET /api/v1/taxonomy` (spec 0.8). */
@Injectable()
export class TaxonomyCatalogueService {
  constructor(
    private readonly taxonomy: TaxonomyService,
    private readonly cities: CityService,
    private readonly config: SystemConfigService,
  ) {}

  async build(): Promise<TaxonomyCatalogue> {
    const catalogue = await this.assemble();

    // A hash of everything served, rather than a stamp somebody has to remember to bump. The
    // stamp only moved on an admin write, so a city added in a deploy, or a limit changed in this
    // file, left every warm client holding an ETag that said nothing had changed.
    return {
      ...catalogue,
      version: createHash('sha256').update(JSON.stringify(catalogue)).digest('hex').slice(0, 16),
    };
  }

  private async assemble(): Promise<TaxonomyCatalogue> {
    const [
      version,
      cities,
      communityCategories,
      professions,
      subcategories,
      skills,
      guideTopics,
      heritageTags,
      journeyStages,
      interests,
      hobbies,
      languages,
      connectionTypes,
      connectPrompts,
      itemCategories,
      itemUnits,
      itemPriceBands,
      storeTypes,
      storeContactChannels,
      storeHelpAreas,
      helpTags,
      guardCategories,
      genders,
      managedCategories,
      experienceLevels,
      urgencyOptions,
      connectAgeBands,
      professionalSortOptions,
      feedTypes,
      requestStatuses,
      commerceSortOptions,
      configured,
    ] = await Promise.all([
      this.taxonomy.version(),
      this.cities.list(),
      // Deactivated terms are returned too, marked `isActive: false`.
      this.taxonomy.list(TaxonomyKind.COMMUNITY_CATEGORY, false),
      this.taxonomy.list(TaxonomyKind.PROFESSION, false),
      this.taxonomy.list(TaxonomyKind.PROFESSION_SUBCATEGORY, false),
      this.taxonomy.list(TaxonomyKind.SKILL, false),
      this.taxonomy.list(TaxonomyKind.GUIDE_TOPIC, false),
      this.taxonomy.list(TaxonomyKind.HERITAGE_TAG, false),
      this.taxonomy.list(TaxonomyKind.JOURNEY_STAGE, false),
      this.taxonomy.list(TaxonomyKind.INTEREST, false),
      this.taxonomy.list(TaxonomyKind.HOBBY, false),
      this.taxonomy.list(TaxonomyKind.LANGUAGE, false),
      this.taxonomy.list(TaxonomyKind.CONNECTION_TYPE, false),
      this.taxonomy.list(TaxonomyKind.CONNECT_PROMPT, false),
      this.taxonomy.list(TaxonomyKind.ITEM_CATEGORY, false),
      this.taxonomy.list(TaxonomyKind.ITEM_UNIT, false),
      this.taxonomy.list(TaxonomyKind.ITEM_PRICE_BAND, false),
      this.taxonomy.list(TaxonomyKind.STORE_TYPE, false),
      this.taxonomy.list(TaxonomyKind.STORE_CONTACT_CHANNEL, false),
      this.taxonomy.list(TaxonomyKind.STORE_HELP_AREA, false),
      this.taxonomy.list(TaxonomyKind.HELP_TAG, false),
      this.taxonomy.list(TaxonomyKind.GUARD_CATEGORY, false),
      this.taxonomy.list(TaxonomyKind.GENDER, false),
      this.taxonomy.list(TaxonomyKind.MANAGED_CATEGORY, false),
      this.taxonomy.list(TaxonomyKind.EXPERIENCE_LEVEL, false),
      this.taxonomy.list(TaxonomyKind.URGENCY, false),
      this.taxonomy.list(TaxonomyKind.CONNECT_AGE_BAND, false),
      this.taxonomy.list(TaxonomyKind.PROFESSIONAL_SORT_OPTION, false),
      this.taxonomy.list(TaxonomyKind.FEED_TYPE, false),
      this.taxonomy.list(TaxonomyKind.REQUEST_STATUS, false),
      this.taxonomy.list(TaxonomyKind.COMMERCE_SORT_OPTION, false),
      configuredLimits(this.config),
    ]);

    return {
      // Replaced by the content hash in `build`. Kept in the payload so a change to the terms
      // themselves still moves it even if the rest of the file were somehow identical.
      version: version.toISOString(),
      // `label` is what the client's CityRef parses; `name` stays for callers already reading it.
      cities: cities.map(city => ({
        id: city.id,
        label: city.name,
        name: city.name,
        region: city.region,
      })),
      communityCategories: communityCategories.map(flatten),
      professions: withSubcategories(professions, subcategories),
      skills: skills.map(flatten),
      guideTopics: guideTopics.map(flatten),
      heritageTags: heritageTags.map(flatten),
      journeyStages: journeyStages.map(flatten),
      interests: interests.map(flatten),
      hobbies: hobbies.map(flatten),
      languages: languages.map(flatten),
      connectionTypes: connectionTypes.map(flatten),
      connectPrompts: connectPrompts.map(flatten),
      itemCategories: itemCategories.map(flatten),
      itemUnits: itemUnits.map(flatten),
      itemPriceBands: itemPriceBands.map(flatten),
      storeTypes: storeTypes.map(flatten),
      storeContactChannels: storeContactChannels.map(flatten),
      storeHelpAreas: storeHelpAreas.map(flatten),
      helpTags: helpTags.map(flatten),
      genders: genders.map(flatten),
      managedCategories: managedCategories.map(flatten),
      experienceLevels: experienceLevels.map(flatten),
      urgencyOptions: urgencyOptions.map(flatten),
      // The same rows as `languages`, under the key the client reads. `iso` rides along in metadata.
      spokenLanguages: languages.map(flatten),
      // The codes are fixed by 6.3.1 and the client already sends them on POST /guard/requests.
      // Serving them here moves the labels, not the codes.
      privateHelpCategories: guardCategories.map(flatten),
      connectAgeBands: connectAgeBands.map(flatten),
      professionalSortOptions: professionalSortOptions.map(flatten),
      // The filter row the client used to select by array index (§1).
      feedTypes: feedTypes.map(flatten),
      requestStatuses: requestStatuses.map(flatten),
      commerceSortOptions: commerceSortOptions.map(flatten),
      limits: { ...TAXONOMY_LIMITS, ...configured },
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
/**
 * Each category with its own children (v2 §3.1).
 *
 * The parent is named in the child's `metadata.parentCode`, which is where a hierarchy belongs in a
 * one-row-per-term table: the alternative was a `parent_id` column on every taxonomy kind, twenty
 * of which have no children and never will.
 *
 * A child whose parent is not in the list is dropped rather than orphaned at the top level — a
 * subcategory with no shelf is a chip nobody can reach, and silently promoting it to a category
 * would put *Immigration solicitor* beside *Immigration*. `subcategories` is omitted entirely for
 * a category with none, because the schema must not force an invented child.
 */
const withSubcategories = (categories: TermRecord[], children: TermRecord[]): CatalogueTerm[] => {
  const byParent = new Map<string, CatalogueTerm[]>();

  for (const child of children) {
    const parent = (child.metadata as { parentCode?: string } | null)?.parentCode;

    if (!parent) continue;

    byParent.set(parent, [...(byParent.get(parent) ?? []), flatten(child)]);
  }

  return categories.map(category => {
    const own = byParent.get(category.code);

    return { ...flatten(category), ...(own?.length ? { subcategories: own } : {}) };
  });
};

const flatten = (term: TermRecord): CatalogueTerm => ({
  code: term.code,
  label: term.label,
  sort: term.sort,
  isActive: term.isActive,
  ...(term.description ? { description: term.description } : {}),
  ...(term.metadata ?? {}),
});
