import { ApiPropertyOptional } from '@nestjs/swagger';
import { ReportTargetType } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsEnum, IsIn, IsOptional } from 'class-validator';
import { AdminPageOptionsDto, CsvArray } from '@/common';

/** The kinds of thing that appear on a member's timeline (§5.4 `ActivityItem`). */
export const ACTIVITY_TYPES = [
  'SIGNUP',
  'LOGIN',
  'CREATE',
  'RESPOND',
  'JOIN',
  'ENQUIRE',
  'BOOK',
  'REPORT_FILED',
  'REPORTED',
  'ENFORCEMENT',
  'PROFILE_EDIT',
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/**
 * The visibility states §4.5 will record per piece of content.
 *
 * Declared here now because the filter is part of the endpoint contract. Until the content-safety
 * table ships, the state is derived from the moderation queue — see `AdminMemberTabsService`.
 */
export const VISIBILITY_STATES = [
  'VISIBLE',
  'LIMITED',
  'HELD',
  'PENDING_APPROVAL',
  'REJECTED',
] as const;

export class MemberActivityQueryDto extends AdminPageOptionsDto {
  @ApiPropertyOptional({ enum: ACTIVITY_TYPES, isArray: true })
  @CsvArray()
  @IsArray()
  @ArrayMaxSize(ACTIVITY_TYPES.length)
  @IsIn(ACTIVITY_TYPES as unknown as string[], { each: true })
  @IsOptional()
  types?: ActivityType[];
}

export class MemberContentQueryDto extends AdminPageOptionsDto {
  @ApiPropertyOptional({ enum: ReportTargetType })
  @IsOptional()
  @IsEnum(ReportTargetType)
  targetType?: ReportTargetType;

  @ApiPropertyOptional({ enum: VISIBILITY_STATES })
  @IsOptional()
  @IsIn(VISIBILITY_STATES as unknown as string[])
  visibilityState?: (typeof VISIBILITY_STATES)[number];
}

export class MemberReportsQueryDto extends AdminPageOptionsDto {
  @ApiPropertyOptional({
    enum: ['filed', 'received'],
    default: 'received',
    description: 'Reports this member made, or reports about them.',
  })
  @IsOptional()
  @IsIn(['filed', 'received'])
  direction?: 'filed' | 'received';
}

export class MemberReviewsQueryDto extends AdminPageOptionsDto {
  @ApiPropertyOptional({ enum: ['given', 'received'], default: 'received' })
  @IsOptional()
  @IsIn(['given', 'received'])
  direction?: 'given' | 'received';
}
