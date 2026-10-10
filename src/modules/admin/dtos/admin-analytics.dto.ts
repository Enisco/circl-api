import { ApiPropertyOptional } from '@nestjs/swagger';
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
import { CsvArray, ToBoolean } from '@/common';
import { GRANULARITIES, Granularity } from './analytics-filter.dto';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The dashboard's own filter: a deliberate **subset** of the shared one (§5.24).
 *
 * `from`, `to`, `compare`, `granularity` and `cityIds`, and nothing else. Declared as its own class
 * rather than reusing `AnalyticsFilterDto` so that `forbidNonWhitelisted` refuses the rest by name
 * — the dashboard is a fixed set of widgets, and a `heritage` filter on it would silently narrow
 * four cards and none of the attention items, which reads as a bug in the numbers.
 */
export class DashboardFilterDto {
  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsOptional()
  @IsString()
  @Matches(ISO_DATE, { message: 'from must be a date in YYYY-MM-DD form.' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-09-30' })
  @IsOptional()
  @IsString()
  @Matches(ISO_DATE, { message: 'to must be a date in YYYY-MM-DD form.' })
  to?: string;

  @ApiPropertyOptional({
    default: true,
    description: 'On by default here, unlike the analytics tabs.',
  })
  @ToBoolean()
  @IsBoolean()
  @IsOptional()
  compare?: boolean = true;

  @ApiPropertyOptional({ enum: GRANULARITIES })
  @IsOptional()
  @IsIn(GRANULARITIES as unknown as string[])
  granularity?: Granularity;

  @ApiPropertyOptional({ description: 'City ids, e.g. `LONDON,MANCHESTER`.' })
  @CsvArray()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  @IsOptional()
  cityIds?: string[];
}

/**
 * Demographics' own extra filter (§5.25).
 *
 * `all` means everybody who had joined by `to`; `signups` restricts to those who joined inside the
 * range. Two genuinely different questions — "what does our membership look like" and "who have we
 * been attracting lately" — and reading one as the other is how a platform concludes its audience
 * has changed when all that changed was the date picker.
 */
export const POPULATIONS = ['all', 'signups'] as const;

export type PopulationMode = (typeof POPULATIONS)[number];

/**
 * The Community tab's own filters (§5.25).
 *
 * `cityIds` is deliberately **not** here: it is part of the shared filter, and on a content tab it
 * narrows the content's own city rather than the author's — which the response says out loud in
 * `meta.filterSemantics` rather than leaving the reader to guess.
 */
export interface CommunityFilters {
  cityIds?: string[];
  categories?: string[];
  guideTopics?: string[];
  requestStatuses?: string[];
  visibility?: string[];
  joinPolicy?: string[];
}

/** The tabs §5.25 defines. One endpoint each, and an unknown name is a 400 rather than an empty tab. */
export const ANALYTICS_TABS = [
  'overview',
  'growth',
  'demographics',
  'community',
  'professionals',
  'connect',
  'commerce',
  'deals',
  'search',
  'trust-safety',
  'support',
  'staff',
] as const;

export type AnalyticsTab = (typeof ANALYTICS_TABS)[number];

/** Which permission opens each tab. Safety has its own, so T&S can see their numbers and no others. */
export const TAB_PERMISSIONS: Record<AnalyticsTab, string[]> = {
  overview: ['analytics:read'],
  growth: ['analytics:read'],
  demographics: ['analytics:read'],
  community: ['analytics:read'],
  professionals: ['analytics:read'],
  connect: ['analytics:read'],
  commerce: ['analytics:read'],
  deals: ['analytics:read'],
  search: ['analytics:read'],
  'trust-safety': ['analytics:read', 'analytics:safety'],
  support: ['analytics:read'],
  staff: ['analytics:read'],
};
