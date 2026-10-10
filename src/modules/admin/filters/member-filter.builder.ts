import { Injectable } from '@nestjs/common';
import { Prisma, TaxonomyKind } from '@prisma/client';
import {
  ApiErrorCode,
  ApiException,
  LONDON_TIMEZONE,
  birthDateRangeForAges,
  dateOnlySpan,
  londonDateString,
  londonMidnight,
  shiftDateOnly,
} from '@/common';
import { CityService, TaxonomyService } from '@/modules/platform/shared';
import { Granularity } from '../dtos/analytics-filter.dto';

/**
 * What the builder reads, as a shape rather than as a class.
 *
 * The shared filter DTO satisfies it, and so does the dashboard's deliberately narrower one (§5.24)
 * — which carries five of these fields and must not carry the rest. Typed structurally so the
 * builder depends on the values it reads instead of on which class they arrived in; otherwise every
 * endpoint with its own subset of the filter would need either a cast or a second builder.
 */
export interface MemberFilterInput {
  from?: string;
  to?: string;
  compare?: boolean;
  granularity?: Granularity;
  cityIds?: string[];
  gender?: string[];
  ageBands?: string[];
  countriesOfOrigin?: string[];
  heritage?: string[];
  journeyStages?: string[];
  interests?: string[];
  languages?: string[];
  platforms?: string[];
  appVersions?: string[];
  signupMethods?: string[];
  statuses?: string[];
  onboarding?: 'completed' | 'not_completed';
}

/** One period, as both London calendar dates and the UTC half-open interval they denote. */
export interface Period {
  from: string;
  to: string;
  /** Inclusive. Midnight London on `from`. */
  fromInstant: Date;
  /** **Exclusive**: midnight London on the day after `to`, so the last day is whole. */
  toInstant: Date;
}

export interface ResolvedRange extends Period {
  granularity: Granularity;
  /** Inclusive day count, which is what the bucket limits are expressed in. */
  days: number;
  timezone: string;
  /** The equal-length period ending the day before `from`, when `compare` was asked for. */
  previous: Period | null;
}

export interface ResolvedMemberFilter {
  /** Null when no range was sent and the endpoint does not impose one (the member list). */
  range: ResolvedRange | null;
  where: Prisma.UserWhereInput;
  /**
   * The same population as a raw predicate against the live tables, for the member list.
   * Assumes `users u LEFT JOIN user_profile p ON p."user_id" = u."id"`.
   */
  sql: Prisma.Sql;
  /**
   * And again against `mv_member_dimensions` (alias `m`), which is where every analytics query
   * starts (§8.2).
   *
   * A third form rather than one, because the two targets answer different questions. The list has
   * to be live — a member who signed up a minute ago must appear in it — and the view is fifteen
   * minutes stale by design. Analytics cannot be live: the same join and the same JSONB unpacking,
   * repeated per chart and indexed nowhere, is what the view exists to remove.
   *
   * All three are emitted in one pass from the same validated values, so a filter added to one is
   * a compile-time hole in the others.
   */
  viewSql: Prisma.Sql;
  /** Which filters are actually in force, for `meta.filtersApplied`. */
  applied: string[];
}

/** Bucket limits (§2.5). A series the portal cannot draw is not one worth computing. */
const MAX_DAYS = { day: 366, week: 1096, month: 1096 } as const;

/** Granularity when the caller does not say, chosen so a chart never has 400 points. */
const granularityFor = (days: number): Granularity =>
  days <= 92 ? 'day' : days <= 731 ? 'week' : 'month';

const DEFAULT_RANGE_DAYS = 30;

/** Which taxonomy each code filter is validated against. */
const VOCABULARIES: Record<string, TaxonomyKind> = {
  heritage: TaxonomyKind.HERITAGE_TAG,
  journeyStages: TaxonomyKind.JOURNEY_STAGE,
  interests: TaxonomyKind.INTEREST,
  languages: TaxonomyKind.LANGUAGE,
};

/**
 * The shared member filter (§2.5), turned into a query.
 *
 * One builder for the member list, every analytics tab, the dashboard, the announcement audience
 * preview and the member export, because all five have to agree about what "members in Leeds aged
 * 25–34" means. The risk it exists to remove is two implementations that drift: a list that counts
 * 41 people and a chart that counts 38 of the same people, with nothing to say which is wrong.
 *
 * It produces two forms of the same predicate — a Prisma `where` and a SQL fragment — because the
 * analytics rollups are raw queries (a year of daily buckets is not something the query builder
 * can express) and the lists are not. They are built side by side, in the same method, from the
 * same validated values, so that a filter added to one is a compile-time hole in the other.
 */
@Injectable()
export class MemberFilterBuilder {
  constructor(
    private readonly cities: CityService,
    private readonly taxonomy: TaxonomyService,
  ) {}

  /**
   * Resolves a filter against the vocabularies and turns it into a query.
   *
   * `options.dateField` says what the date range means for this endpoint. On the member list it is
   * the sign-up date and narrows the population; on an analytics tab it is the chart's own axis and
   * must not touch the population, or every series would be restricted to members who joined
   * inside the window. `options.defaultRange` is what makes the member list's "no default date
   * range" rule true (§5.4) while every analytics endpoint still gets its thirty days.
   */
  async resolve(
    filter: MemberFilterInput,
    options: { defaultRange?: boolean; dateField?: 'createdAt' } = {},
  ): Promise<ResolvedMemberFilter> {
    const range = this.resolveRange(filter, options.defaultRange ?? true);
    const applied: string[] = [];

    const and: Prisma.UserWhereInput[] = [];
    const sql: Prisma.Sql[] = [];
    const viewSql: Prisma.Sql[] = [];

    const add = (
      name: string,
      where: Prisma.UserWhereInput,
      predicate: Prisma.Sql,
      viewPredicate: Prisma.Sql,
    ): void => {
      applied.push(name);
      and.push(where);
      sql.push(predicate);
      viewSql.push(viewPredicate);
    };

    if (range && options.dateField === 'createdAt') {
      add(
        'signupDate',
        { createdAt: { gte: range.fromInstant, lt: range.toInstant } },
        Prisma.sql`u."created_at" >= ${range.fromInstant} AND u."created_at" < ${range.toInstant}`,
        Prisma.sql`m."created_at" >= ${range.fromInstant} AND m."created_at" < ${range.toInstant}`,
      );
    }

    if (filter.cityIds?.length) {
      const ids = await this.assertCities(filter.cityIds);

      add(
        'cityIds',
        { profile: { cityId: { in: ids } } },
        Prisma.sql`p."city_id" IN (${Prisma.join(ids)})`,
        Prisma.sql`m."city_id" IN (${Prisma.join(ids)})`,
      );
    }

    if (filter.gender?.length) {
      const values = filter.gender.filter(value => value !== 'UNKNOWN');
      const unknown = filter.gender.includes('UNKNOWN');

      add(
        'gender',
        this.orNullable({ profile: { gender: { in: values as never[] } } }, unknown, {
          profile: { gender: null },
        }),
        this.sqlOrNull(
          values.length ? Prisma.sql`p."gender"::text IN (${Prisma.join(values)})` : null,
          unknown ? Prisma.sql`p."gender" IS NULL` : null,
        ),
        this.sqlOrNull(
          values.length ? Prisma.sql`m."gender" IN (${Prisma.join(values)})` : null,
          unknown ? Prisma.sql`m."gender" IS NULL` : null,
        ),
      );
    }

    if (filter.ageBands?.length) {
      await this.addAgeBands(filter.ageBands, range?.to ?? londonDateString(), add);
    }

    if (filter.countriesOfOrigin?.length) {
      const codes = this.assertCountryCodes(filter.countriesOfOrigin);
      const other = filter.countriesOfOrigin.includes('OTHER');

      add(
        'countriesOfOrigin',
        this.orNullable({ profile: { countryOfOriginCode: { in: codes } } }, other, {
          profile: { countryOfOriginCode: null },
        }),
        this.sqlOrNull(
          codes.length ? Prisma.sql`p."country_of_origin_code" IN (${Prisma.join(codes)})` : null,
          other ? Prisma.sql`p."country_of_origin_code" IS NULL` : null,
        ),
        this.sqlOrNull(
          codes.length ? Prisma.sql`m."country_code" IN (${Prisma.join(codes)})` : null,
          other ? Prisma.sql`m."country_code" IS NULL` : null,
        ),
      );
    }

    if (filter.heritage?.length) {
      const codes = await this.assertCodes('heritage', filter.heritage);

      add(
        'heritage',
        { profile: { heritageTag: { in: codes } } },
        Prisma.sql`p."heritage_tag" IN (${Prisma.join(codes)})`,
        Prisma.sql`m."heritage_tag" IN (${Prisma.join(codes)})`,
      );
    }

    if (filter.journeyStages?.length) {
      const codes = await this.assertCodes('journeyStages', filter.journeyStages);

      add(
        'journeyStages',
        { profile: { journeyStage: { in: codes } } },
        Prisma.sql`p."journey_stage" IN (${Prisma.join(codes)})`,
        Prisma.sql`m."journey_stage" IN (${Prisma.join(codes)})`,
      );
    }

    if (filter.interests?.length) {
      const codes = await this.assertCodes('interests', filter.interests);

      add(
        'interests',
        { OR: codes.map(code => ({ profile: { interests: { array_contains: [code] } } })) },
        this.sqlHoldsAny('interests', codes),
        Prisma.sql`m."interests" && ${codes}::text[]`,
      );
    }

    if (filter.languages?.length) {
      const codes = await this.assertCodes('languages', filter.languages);

      add(
        'languages',
        { OR: codes.map(code => ({ profile: { languages: { array_contains: [code] } } })) },
        this.sqlHoldsAny('languages', codes),
        Prisma.sql`m."languages" && ${codes}::text[]`,
      );
    }

    if (filter.platforms?.length) {
      const values = filter.platforms;

      add(
        'platforms',
        { lastPlatform: { in: values as never[] } },
        Prisma.sql`u."last_platform"::text IN (${Prisma.join(values)})`,
        Prisma.sql`m."platform" IN (${Prisma.join(values)})`,
      );
    }

    if (filter.appVersions?.length) {
      const values = filter.appVersions;

      add(
        'appVersions',
        { lastAppVersion: { in: values } },
        Prisma.sql`u."last_app_version" IN (${Prisma.join(values)})`,
        Prisma.sql`m."app_version" IN (${Prisma.join(values)})`,
      );
    }

    if (filter.signupMethods?.length) {
      const values = filter.signupMethods;

      add(
        'signupMethods',
        { signupMethod: { in: values as never[] } },
        Prisma.sql`u."signup_method"::text IN (${Prisma.join(values)})`,
        Prisma.sql`m."signup_method" IN (${Prisma.join(values)})`,
      );
    }

    if (filter.statuses?.length) {
      const values = filter.statuses;

      add(
        'statuses',
        { status: { in: values as never[] } },
        Prisma.sql`u."status"::text IN (${Prisma.join(values)})`,
        Prisma.sql`m."status" IN (${Prisma.join(values)})`,
      );
    }

    if (filter.onboarding) {
      const completed = filter.onboarding === 'completed';

      // "Not completed" has to include a member with no profile row at all, or the funnel loses
      // exactly the people who dropped out before one was written.
      add(
        'onboarding',
        this.orNullable({ profile: { onboardingCompleted: completed } }, !completed, {
          profile: { is: null },
        }),
        completed
          ? Prisma.sql`p."onboarding_completed" = true`
          : Prisma.sql`COALESCE(p."onboarding_completed", false) = false`,
        Prisma.sql`m."onboarding_completed" = ${completed}`,
      );
    }

    return {
      range,
      where: { ...MemberFilterBuilder.POPULATION, ...(and.length ? { AND: and } : {}) },
      sql: Prisma.sql`${MemberFilterBuilder.POPULATION_SQL}${
        sql.length ? Prisma.sql` AND ${Prisma.join(sql, ' AND ')}` : Prisma.empty
      }`,
      // The view already excludes staff, anonymised and deleted accounts — that is its `WHERE` —
      // so there is nothing to repeat here. `TRUE` rather than an empty string so the fragment is
      // always a legal predicate, however it is composed.
      viewSql: viewSql.length ? Prisma.join(viewSql, ' AND ') : Prisma.sql`TRUE`,
      applied,
    };
  }

  /**
   * Who counts as a member, on every list and every chart (§2.5).
   *
   * Staff are excluded because they are listed under Team and would otherwise appear in the
   * demographics of a product they work on. Anonymised accounts are excluded because the personal
   * data is gone: they would land in every "unknown" bucket and quietly grow it.
   */
  static readonly POPULATION: Prisma.UserWhereInput = {
    isStaff: false,
    isAnonymised: false,
    deletedAt: null,
  };

  static readonly POPULATION_SQL = Prisma.sql`u."is_staff" = false AND u."is_anonymised" = false AND u."deleted_at" IS NULL`;

  /** The date range, the granularity and the comparison period, with the bucket limits applied. */
  private resolveRange(filter: MemberFilterInput, useDefault: boolean): ResolvedRange | null {
    if (!filter.from && !filter.to && !useDefault) return null;

    const to = filter.to ?? londonDateString();
    const from = filter.from ?? shiftDateOnly(to, -(DEFAULT_RANGE_DAYS - 1));

    if (Date.parse(from) > Date.parse(to)) {
      throw ApiException.badRequest(
        ApiErrorCode.VALIDATION_FAILED,
        'The start of the range is after the end of it.',
        { details: [{ field: 'from', message: 'Must not be later than `to`.' }] },
      );
    }

    const days = dateOnlySpan(from, to);
    const granularity = filter.granularity ?? granularityFor(days);
    const limit = MAX_DAYS[granularity];

    if (days > limit) {
      throw ApiException.badRequest(
        ApiErrorCode.FILTER_RANGE_TOO_LARGE,
        `A ${granularity} range covers at most ${limit} days. That one covers ${days}.`,
        { details: [{ field: 'from', message: `At most ${limit} days by ${granularity}.` }] },
      );
    }

    const previousTo = shiftDateOnly(from, -1);
    const previousFrom = shiftDateOnly(previousTo, -(days - 1));

    return {
      ...this.period(from, to),
      granularity,
      days,
      timezone: LONDON_TIMEZONE,
      previous: filter.compare ? this.period(previousFrom, previousTo) : null,
    };
  }

  private period(from: string, to: string): Period {
    return {
      from,
      to,
      fromInstant: londonMidnight(from),
      // Exclusive, and built from the next calendar day rather than by adding 24 hours: on the day
      // the clocks go forward the day is 23 hours long, and `+1 day` would drop its last hour.
      toInstant: londonMidnight(shiftDateOnly(to, 1)),
    };
  }

  /** A filter whose values include "not set", which is a different query from the values. */
  private orNullable(
    forValues: Prisma.UserWhereInput,
    includeNull: boolean,
    forNull: Prisma.UserWhereInput,
  ): Prisma.UserWhereInput {
    if (!includeNull) return forValues;

    // A member with no profile row is "not set" too, and `profile: { … }` is an inner join that
    // would silently drop them.
    return { OR: [forValues, forNull, { profile: { is: null } }] };
  }

  /**
   * "The JSON array in this column holds any of these codes."
   *
   * One `@>` per code rather than one containment test over all of them: `@> '["A","B"]'` asks
   * whether the profile holds *both*, and the rule is any (§2.5). Each test is an index lookup on
   * the `jsonb_path_ops` GIN index.
   */
  private sqlHoldsAny(column: 'interests' | 'languages', codes: string[]): Prisma.Sql {
    return Prisma.sql`(${Prisma.join(
      codes.map(
        code => Prisma.sql`p.${Prisma.raw(`"${column}"`)} @> ${JSON.stringify([code])}::jsonb`,
      ),
      ' OR ',
    )})`;
  }

  private sqlOrNull(forValues: Prisma.Sql | null, forNull: Prisma.Sql | null): Prisma.Sql {
    const parts = [forValues, forNull].filter((part): part is Prisma.Sql => part !== null);

    return Prisma.sql`(${Prisma.join(parts, ' OR ')})`;
  }

  /**
   * Age bands, as a filter on the birth date column.
   *
   * Age is derived, not stored, and deriving it per row would mean filtering in memory — so the
   * page and the count would be computed from different sets. The bounds come from the
   * `CONNECT_AGE_BAND` taxonomy's own `minAge`/`maxAge` metadata rather than being restated here,
   * because the labels staff see and the ranges the query uses have to be the same numbers.
   *
   * Ages are computed at the **end** of the range (§2.5), so a chart does not move a member between
   * bands because it was rendered a week later.
   */
  private async addAgeBands(
    bands: string[],
    atDate: string,
    add: (name: string, where: Prisma.UserWhereInput, sql: Prisma.Sql, viewSql: Prisma.Sql) => void,
  ): Promise<void> {
    const at = londonMidnight(atDate);
    const terms = await this.taxonomy.list(TaxonomyKind.CONNECT_AGE_BAND, false);
    const wanted = bands.filter(band => band !== 'UNKNOWN');
    const unknown = bands.includes('UNKNOWN');

    const windows = wanted.map(band => {
      const term = terms.find(entry => entry.code === band);
      const metadata = (term?.metadata ?? {}) as { minAge?: number; maxAge?: number | null };

      if (!term || typeof metadata.minAge !== 'number') {
        throw ApiException.badRequest(
          ApiErrorCode.UNKNOWN_TAXONOMY_CODE,
          `"${band}" is not an age band.`,
          { details: [{ field: 'ageBands', message: `"${band}" is not an age band.` }] },
        );
      }

      return birthDateRangeForAges(metadata.minAge, metadata.maxAge ?? undefined, at);
    });

    const where: Prisma.UserWhereInput[] = windows.map(window => ({
      profile: {
        dateOfBirth: {
          ...(window.earliest ? { gt: window.earliest } : {}),
          ...(window.latest ? { lte: window.latest } : {}),
        },
      },
    }));

    const forAlias = (alias: string): Prisma.Sql[] =>
      windows.map(
        window =>
          Prisma.sql`(${Prisma.join(
            [
              window.earliest
                ? Prisma.sql`${Prisma.raw(alias)}."date_of_birth" > ${window.earliest}`
                : null,
              window.latest
                ? Prisma.sql`${Prisma.raw(alias)}."date_of_birth" <= ${window.latest}`
                : null,
            ].filter((part): part is Prisma.Sql => part !== null),
            ' AND ',
          )})`,
      );

    const predicates = forAlias('p');
    const viewPredicates = forAlias('m');

    if (unknown) {
      where.push({ profile: { dateOfBirth: null } }, { profile: { is: null } });
      predicates.push(Prisma.sql`p."date_of_birth" IS NULL`);
      viewPredicates.push(Prisma.sql`m."date_of_birth" IS NULL`);
    }

    add(
      'ageBands',
      { OR: where },
      Prisma.sql`(${Prisma.join(predicates, ' OR ')})`,
      Prisma.sql`(${Prisma.join(viewPredicates, ' OR ')})`,
    );
  }

  /**
   * Cities, rejected rather than ignored when unknown.
   *
   * A 400 rather than the 422 `CityService.assertValid` raises: in a filter an unknown code is a
   * malformed request (§2.8), and quietly dropping it would answer a different question from the
   * one asked and label the answer with the question.
   */
  private async assertCities(ids: string[]): Promise<string[]> {
    const resolved = await Promise.all(
      [...new Set(ids)].map(async id => ({ id, city: await this.cities.resolve(id) })),
    );
    const unknown = resolved.filter(entry => !entry.city).map(entry => entry.id);

    if (unknown.length) {
      const message = `Not a known city: ${unknown.join(', ')}.`;

      throw ApiException.badRequest(ApiErrorCode.UNKNOWN_CITY, message, {
        details: [{ field: 'cityIds', message }],
      });
    }

    return resolved.map(entry => entry.city!.id);
  }

  /** Taxonomy codes, including retired ones: members still hold those, and so must a filter. */
  private async assertCodes(field: string, values: string[]): Promise<string[]> {
    const kind = VOCABULARIES[field];
    const terms = await this.taxonomy.list(kind, false);
    const known = new Set(terms.map(term => term.code));
    const codes = [...new Set(values)];
    const unknown = codes.filter(code => !known.has(code));

    if (unknown.length) {
      const message = `Not a known ${kind} code: ${unknown.join(', ')}.`;

      throw ApiException.badRequest(ApiErrorCode.UNKNOWN_TAXONOMY_CODE, message, {
        details: [{ field, message }],
      });
    }

    return codes;
  }

  /** ISO 3166-1 alpha-2, which is what the column holds. `OTHER` is not a country: it is null. */
  private assertCountryCodes(values: string[]): string[] {
    const codes = [...new Set(values)].filter(value => value !== 'OTHER');
    const malformed = codes.filter(code => !/^[A-Za-z]{2}$/.test(code));

    if (malformed.length) {
      const message = `Not an ISO 3166-1 alpha-2 country code: ${malformed.join(', ')}.`;

      throw ApiException.badRequest(ApiErrorCode.UNKNOWN_TAXONOMY_CODE, message, {
        details: [{ field: 'countriesOfOrigin', message }],
      });
    }

    return codes.map(code => code.toUpperCase());
  }
}
