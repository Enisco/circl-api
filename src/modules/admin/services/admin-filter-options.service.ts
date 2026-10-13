import { Injectable } from '@nestjs/common';
import { ReportReason, RiskCategory, TaxonomyKind } from '@prisma/client';
import { CacheService, PrismaService } from '@/infrastructure';
import { countryNameOf, TaxonomyService } from '@/modules/platform/shared';
import {
  AGE_BANDS,
  GENDERS,
  MEMBER_STATUSES,
  PLATFORMS,
  SIGNUP_METHODS,
} from '../dtos/analytics-filter.dto';
import { SUPPRESSION_FLOOR } from '../analytics/suppression';

export interface FilterOption {
  code: string;
  label: string;
  /** The city's region, or the app version's platform — whatever the portal groups the list by. */
  group?: string;
}

/** How long the filter bar's options are worth keeping. §5.25: ten minutes. */
const TTL_SECONDS = 600;

/** How far back an app version has to have been seen to be worth offering as a filter. */
const APP_VERSION_DAYS = 180;

const CACHE_KEY = 'admin:filter-options:v1';

/**
 * Codes whose name is not what title-casing produces.
 *
 * `IOS` becomes "Ios", which is nobody's name for it and looks like a bug in the filter bar — and
 * the same label is the group heading on every app version, so it would appear a dozen times.
 */
const NAMED: Record<string, string> = { IOS: 'iOS', ANDROID: 'Android' };

/** `SCREAMING_SNAKE` into something a person reads. */
const labelOf = (code: string): string =>
  NAMED[code] ??
  code
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^./, first => first.toUpperCase());

const optionsFor = (codes: readonly string[]): FilterOption[] =>
  codes.map(code => ({ code, label: labelOf(code) }));

/**
 * The values the filter bar offers (§5.25).
 *
 * One rule governs this whole file: **every option is built from the same constant the filter DTO
 * validates against**. Not a parallel list that agrees with it today — the identical export. A
 * filter bar offering a value the API rejects is worse than one missing a value, because the staff
 * member has no way to tell a bad filter from no data, and there is a unit test asserting the two
 * sides cannot drift.
 *
 * The dynamic lists — cities, countries, app versions — come from what is actually in the data, so
 * a dropdown never offers a country nobody is from.
 */
@Injectable()
export class AdminFilterOptionsService {
  constructor(
    private readonly database: PrismaService,
    private readonly cache: CacheService,
    private readonly taxonomy: TaxonomyService,
  ) {}

  async options(): Promise<Record<string, FilterOption[]>> {
    const cached = await this.cache.get<Record<string, FilterOption[]>>(CACHE_KEY);

    if (cached) return cached;

    const [cities, countries, appVersions, vocabularies] = await Promise.all([
      this.cities(),
      this.countries(),
      this.appVersions(),
      this.vocabularies(),
    ]);

    const options: Record<string, FilterOption[]> = {
      cityIds: cities,
      gender: optionsFor(GENDERS),
      ageBands: await this.ageBands(),
      countriesOfOrigin: countries,
      platforms: optionsFor(PLATFORMS),
      appVersions,
      signupMethods: optionsFor(SIGNUP_METHODS),
      statuses: optionsFor(MEMBER_STATUSES),
      // `reasonCodes`, not `reportReasons`. §5.25's `FilterOptions` interface spells it the second
      // way, but its own stated rule is that "response keys match the `AnalyticsFilter` param
      // names so the portal can bind them directly" — and the param is `reasonCodes`. Publishing
      // the interface's spelling hands the portal a key that 400s on `forbidNonWhitelisted`, which
      // reads to a staff member as a refused filter they cannot tell from an empty result.
      reasonCodes: optionsFor(Object.values(ReportReason)),
      riskCategories: optionsFor(Object.values(RiskCategory)),
      ...vocabularies,
    };

    await this.cache.set(CACHE_KEY, options, TTL_SECONDS);

    return options;
  }

  /**
   * Active cities, grouped by region.
   *
   * Inactive ones are left out: a city staff cannot recruit into is not a filter, and offering it
   * invites somebody to wonder why it always reads zero.
   */
  private async cities(): Promise<FilterOption[]> {
    const rows = await this.database.city.findMany({
      where: { isActive: true },
      select: { id: true, name: true, region: true },
      orderBy: [{ region: 'asc' }, { name: 'asc' }],
    });

    return rows.map(row => ({
      code: row.id,
      label: row.name,
      ...(row.region ? { group: row.region } : {}),
    }));
  }

  /**
   * The countries members actually come from, with the §2.7 floor applied.
   *
   * A country fewer than ten members gave is withheld from the **list**, not just from a count:
   * offering "Country with 1 member" in a dropdown is the disclosure, and a staff member who
   * selects it learns the number by seeing one row. This is the same reasoning as the search terms
   * table — the option's existence is the fact.
   *
   * Names come from ICU rather than a seeded vocabulary, so there is no list to keep in step.
   */
  private async countries(): Promise<FilterOption[]> {
    const rows = await this.database.$queryRaw<Array<{ code: string; total: bigint }>>`
      SELECT m."country_code" AS code, COUNT(*) AS total
      FROM "mv_member_dimensions" m
      WHERE m."country_code" IS NOT NULL
      GROUP BY 1
      HAVING COUNT(*) >= ${SUPPRESSION_FLOOR}
      ORDER BY 2 DESC
    `;

    return rows
      .map(row => ({ code: row.code, label: countryNameOf(row.code) ?? row.code }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  /**
   * The builds still in the wild, by platform.
   *
   * Sorted newest first by version rather than alphabetically, because `2.10.0` sorts before
   * `2.9.0` as a string and a release list in the wrong order is read as the wrong release.
   */
  private async appVersions(): Promise<FilterOption[]> {
    const since = new Date(Date.now() - APP_VERSION_DAYS * 86_400_000);
    const rows = await this.database.$queryRaw<Array<{ version: string; platform: string | null }>>`
      SELECT DISTINCT s."app_version" AS version, s."platform"::text AS platform
      FROM "user_sessions" s
      WHERE s."app_version" IS NOT NULL
        AND s."last_active_at" >= ${since}
    `;

    return rows
      .map(row => ({
        code: row.version,
        label: row.version,
        ...(row.platform ? { group: labelOf(row.platform) } : {}),
      }))
      .sort(
        (a, b) => (a.group ?? '').localeCompare(b.group ?? '') || compareVersions(b.code, a.code),
      );
  }

  /**
   * The age bands, labelled from the taxonomy staff can reword.
   *
   * The codes are the filter's own, because they are what it validates; the labels come from
   * `CONNECT_AGE_BAND`, which is where the bounds live (§8.2). A band whose label staff have
   * changed must read the same way here as it does in the app.
   */
  private async ageBands(): Promise<FilterOption[]> {
    const labels = await this.taxonomy.labels(TaxonomyKind.CONNECT_AGE_BAND);

    return AGE_BANDS.map(code => ({ code, label: labels.get(code) ?? labelOf(code) }));
  }

  /** The taxonomy-backed lists, in the vocabulary's own order rather than alphabetically. */
  private async vocabularies(): Promise<Record<string, FilterOption[]>> {
    const kinds: Array<[string, TaxonomyKind]> = [
      ['heritage', TaxonomyKind.HERITAGE_TAG],
      ['journeyStages', TaxonomyKind.JOURNEY_STAGE],
      ['interests', TaxonomyKind.INTEREST],
      ['languages', TaxonomyKind.LANGUAGE],
      ['categories', TaxonomyKind.COMMUNITY_CATEGORY],
      ['guideTopics', TaxonomyKind.GUIDE_TOPIC],
      ['professions', TaxonomyKind.PROFESSION],
      ['connectionTypes', TaxonomyKind.CONNECTION_TYPE],
      ['storeTypes', TaxonomyKind.STORE_TYPE],
      ['itemCategories', TaxonomyKind.ITEM_CATEGORY],
      // Guard categories are deliberately **not** here, though the portal asked for them here.
      // Every key this endpoint publishes is an `AnalyticsFilter` parameter — that is the stated
      // contract and its own e2e asserts it, because a key the analytics endpoint refuses reads to
      // a staff member as a filter that returns nothing. The safeguarding vocabulary is not an
      // analytics filter; it is the escalation sheet's picker, so it is served beside
      // `escalationCategories` on `admin/meta/enums`.
    ];

    const lists = await Promise.all(
      kinds.map(async ([field, kind]) => {
        const terms = await this.taxonomy.list(kind);

        return [field, terms.map(term => ({ code: term.code, label: term.label }))] as [
          string,
          FilterOption[],
        ];
      }),
    );

    return Object.fromEntries(lists);
  }
}

/** Semver, numerically. `2.10.0` is newer than `2.9.0`, which string order gets backwards. */
const compareVersions = (left: string, right: string): number => {
  const parts = (value: string) => value.split(/[.\-+]/).map(part => Number.parseInt(part, 10));
  const a = parts(left);
  const b = parts(right);

  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const one = Number.isFinite(a[index]) ? a[index] : 0;
    const two = Number.isFinite(b[index]) ? b[index] : 0;

    if (one !== two) return one - two;
  }

  // Equal numerically but spelled differently (a build suffix): keep it stable and alphabetical.
  return left.localeCompare(right);
};
