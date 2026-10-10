import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { AdminPageOptionsDto, CsvArray, ToBoolean } from '@/common';

/** London calendar dates, which is what every date in the portal is (§2.6). */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * How many values one array filter may carry.
 *
 * Fifty. Every entry becomes a parameter in a query or a branch in an `OR`, so an unbounded list
 * is a way to make one request cost whatever the caller likes — and nobody has ever meaningfully
 * filtered by fifty-one cities.
 */
const MAX_VALUES = 50;

export const GRANULARITIES = ['day', 'week', 'month'] as const;
export type Granularity = (typeof GRANULARITIES)[number];

export const GENDERS = ['MALE', 'FEMALE', 'NON_BINARY', 'OTHER', 'UNKNOWN'] as const;
export const AGE_BANDS = ['AGE_18_24', 'AGE_25_34', 'AGE_35_44', 'AGE_45_PLUS', 'UNKNOWN'] as const;
export const PLATFORMS = ['IOS', 'ANDROID'] as const;
export const SIGNUP_METHODS = ['EMAIL', 'GOOGLE', 'APPLE'] as const;
export const MEMBER_STATUSES = ['ACTIVE', 'SUSPENDED', 'PENDING'] as const;

const Codes =
  (max = MAX_VALUES) =>
  (target: object, key: string) => {
    CsvArray()(target, key);
    IsArray()(target, key);
    ArrayMaxSize(max)(target, key);
    IsString({ each: true })(target, key);
    MaxLength(60, { each: true })(target, key);
    IsOptional()(target, key);
  };

const Enumerated = (values: readonly string[]) => (target: object, key: string) => {
  CsvArray()(target, key);
  IsArray()(target, key);
  ArrayMaxSize(values.length)(target, key);
  IsIn(values as string[], { each: true })(target, key);
  IsOptional()(target, key);
};

/**
 * The filter every analytics endpoint, the dashboard, the member list, the audience preview and
 * the member export take (§2.5).
 *
 * One class, used both as a query string and as a request body: `POST admin/members/search` and
 * `POST admin/search` exist so that names and email addresses never reach a URL, a browser history
 * or an access log, and they must take exactly what the `GET` takes or the portal would have two
 * filter contracts to keep in step.
 *
 * It extends the admin paging options rather than sitting beside them. The spec writes the member
 * list's query as `AdminPageOptions & AnalyticsFilter`, and most analytics tabs carry a table
 * under the chart that needs the same `page`, `perPage` and `sort`. Nest's `IntersectionType`
 * would have produced the intersection without the two methods on `AdminPageOptionsDto` —
 * `assertDepth` and `sortField` are prototype methods, and mapped types copy decorator metadata,
 * not prototypes — so every call site would have had to re-implement the depth limit.
 *
 * Nothing here is validated against a vocabulary: `cityIds` and the taxonomy codes need the
 * database, so they are checked in `MemberFilterBuilder`, which is also where they are turned into
 * a query. A DTO that validated them would need an async validator per field and would still not
 * be the thing that uses them.
 */
export class AnalyticsFilterDto extends AdminPageOptionsDto {
  @ApiPropertyOptional({
    description: 'London calendar date, inclusive. Defaults to 30 days before `to`.',
    example: '2026-09-01',
  })
  @IsOptional()
  @IsString()
  @Matches(ISO_DATE, { message: 'from must be a date in YYYY-MM-DD form.' })
  from?: string;

  @ApiPropertyOptional({
    description: 'London calendar date, inclusive. Defaults to today in London.',
    example: '2026-09-30',
  })
  @IsOptional()
  @IsString()
  @Matches(ISO_DATE, { message: 'to must be a date in YYYY-MM-DD form.' })
  to?: string;

  @ApiPropertyOptional({
    description:
      'Also return the previous period of equal length, ending the day before `from`, for every ' +
      'series and KPI.',
  })
  @ToBoolean()
  @IsBoolean()
  @IsOptional()
  compare?: boolean;

  @ApiPropertyOptional({
    enum: GRANULARITIES,
    description: 'Omit and the range picks it: day ≤ 92 days, week ≤ 731, else month.',
  })
  @IsOptional()
  @IsIn(GRANULARITIES as unknown as string[])
  granularity?: Granularity;

  @ApiPropertyOptional({ description: 'City ids, e.g. `LONDON,MANCHESTER`.' })
  @Codes()
  cityIds?: string[];

  @ApiPropertyOptional({ enum: GENDERS, isArray: true, description: '`UNKNOWN` means not set.' })
  @Enumerated(GENDERS)
  gender?: string[];

  @ApiPropertyOptional({
    enum: AGE_BANDS,
    isArray: true,
    description: 'The `CONNECT_AGE_BAND` codes. Age is computed at `to`.',
  })
  @Enumerated(AGE_BANDS)
  ageBands?: string[];

  @ApiPropertyOptional({
    description: 'ISO 3166-1 alpha-2, or `OTHER` for a country not recorded.',
  })
  @Codes()
  countriesOfOrigin?: string[];

  @ApiPropertyOptional({ description: '`HERITAGE_TAG` codes.' })
  @Codes()
  heritage?: string[];

  @ApiPropertyOptional({ description: '`JOURNEY_STAGE` codes.' })
  @Codes()
  journeyStages?: string[];

  @ApiPropertyOptional({ description: '`INTEREST` codes. Matches any.' })
  @Codes()
  interests?: string[];

  @ApiPropertyOptional({ description: '`LANGUAGE` codes. Matches any.' })
  @Codes()
  languages?: string[];

  @ApiPropertyOptional({ enum: PLATFORMS, isArray: true })
  @Enumerated(PLATFORMS)
  platforms?: string[];

  @ApiPropertyOptional({ description: 'App versions, e.g. `2.1.0,2.2.0`.' })
  @Codes(20)
  appVersions?: string[];

  @ApiPropertyOptional({ enum: SIGNUP_METHODS, isArray: true })
  @Enumerated(SIGNUP_METHODS)
  signupMethods?: string[];

  @ApiPropertyOptional({ enum: MEMBER_STATUSES, isArray: true })
  @Enumerated(MEMBER_STATUSES)
  statuses?: string[];

  @ApiPropertyOptional({ enum: ['completed', 'not_completed'] })
  @IsOptional()
  @IsIn(['completed', 'not_completed'])
  onboarding?: 'completed' | 'not_completed';

  /** Whether any filter narrows the *population* rather than the date range (§2.7 suppression). */
  get hasMemberAttributeFilters(): boolean {
    return (
      [
        this.cityIds,
        this.gender,
        this.ageBands,
        this.countriesOfOrigin,
        this.heritage,
        this.journeyStages,
        this.interests,
        this.languages,
        this.platforms,
        this.appVersions,
        this.signupMethods,
        this.statuses,
      ].some(values => (values?.length ?? 0) > 0) || this.onboarding !== undefined
    );
  }
}

/** The member list's own filters, on top of the shared ones (§5.4). */
export class ListMembersDto extends AnalyticsFilterDto {
  @ApiPropertyOptional({
    description:
      'Name, username, exact id, or an exact email address. Matching an email needs ' +
      '`members:pii_reveal`; without it an email query matches nothing, so the list cannot be ' +
      'used to confirm a masked address.',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  declare q?: string;

  @ApiPropertyOptional({ description: 'Members carrying at least one live strike.' })
  @ToBoolean()
  @IsBoolean()
  @IsOptional()
  hasStrikes?: boolean;

  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsOptional()
  @IsString()
  @Matches(ISO_DATE, { message: 'lastActiveFrom must be a date in YYYY-MM-DD form.' })
  lastActiveFrom?: string;

  @ApiPropertyOptional({ example: '2026-09-30' })
  @IsOptional()
  @IsString()
  @Matches(ISO_DATE, { message: 'lastActiveTo must be a date in YYYY-MM-DD form.' })
  lastActiveTo?: string;

  @ApiPropertyOptional({
    description:
      'Members with a listing, a Connect profile or a shop: `PROFESSIONAL,CONNECT,STORE`.',
  })
  @Enumerated(['PROFESSIONAL', 'CONNECT', 'STORE'])
  hasSection?: string[];
}
