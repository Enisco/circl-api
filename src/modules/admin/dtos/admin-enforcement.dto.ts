import { ApiPropertyOptional } from '@nestjs/swagger';
import { AdminReasonCode } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsISO8601, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { AdminPageOptionsDto, CsvArray, ToBoolean } from '@/common';

/**
 * The two kinds of enforcement there are.
 *
 * A warning is **not** a third: §4.4 is explicit that a warning is a strike, and `source` says
 * where it came from. Offering `WARNING` here would be a filter that silently returns a subset of
 * `STRIKE` and leaves staff wondering which of the two numbers is the real one.
 */
export const ENFORCEMENT_KINDS = ['STRIKE', 'SUSPENSION'] as const;

export type EnforcementKind = (typeof ENFORCEMENT_KINDS)[number];

export const ENFORCEMENT_SORTS = ['issuedAt', 'expiresAt'] as const;

/** §5.14's log query. */
export class ListEnforcementDto extends AdminPageOptionsDto {
  @ApiPropertyOptional({
    enum: ENFORCEMENT_KINDS,
    isArray: true,
    description: 'Comma-separated. Both by default. A warning **is** a strike (§4.4).',
  })
  @CsvArray()
  @IsIn([...ENFORCEMENT_KINDS], { each: true })
  @IsOptional()
  kind?: EnforcementKind[];

  @ApiPropertyOptional({
    description:
      'Only what is still in force: an unrevoked, unexpired strike, or a suspension nobody has ' +
      'lifted that has not run out.',
  })
  @ToBoolean()
  @IsBoolean()
  @IsOptional()
  active?: boolean;

  @ApiPropertyOptional({ description: 'Everything done to one member.' })
  @IsString()
  @IsOptional()
  memberId?: string;

  @ApiPropertyOptional({ description: 'Everything one staff member issued.' })
  @IsString()
  @IsOptional()
  issuedById?: string;

  @ApiPropertyOptional({ enum: AdminReasonCode, isArray: true })
  @CsvArray()
  @IsIn(Object.values(AdminReasonCode), { each: true })
  @IsOptional()
  reasonCode?: AdminReasonCode[];

  @ApiPropertyOptional({ description: 'Issued on or after this instant.' })
  @IsISO8601()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({ description: 'Issued before this instant.' })
  @IsISO8601()
  @IsOptional()
  to?: string;

  @ApiPropertyOptional({ enum: ENFORCEMENT_SORTS, default: 'issuedAt' })
  @IsIn([...ENFORCEMENT_SORTS])
  @IsOptional()
  declare sort?: string;
}

/** §5.14's active-suspension list. Only `endsAt` is sortable, because that is the whole question. */
export class ListActiveSuspensionsDto extends AdminPageOptionsDto {
  @ApiPropertyOptional({
    enum: ['endsAt'],
    default: 'endsAt',
    description: 'Nulls last: a permanent suspension has no end date, not an infinitely far one.',
  })
  @IsIn(['endsAt'])
  @IsOptional()
  declare sort?: string;
}

/** §5.14's blocks aggregate. */
export class ListBlocksDto extends AdminPageOptionsDto {
  @ApiPropertyOptional({
    minimum: 1,
    default: 3,
    description:
      'The floor for appearing at all. Three, because one block is a disagreement and ten is a ' +
      'pattern — and a list that starts at one is every member who has ever annoyed somebody.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  minBlocksReceived?: number;

  @ApiPropertyOptional({ description: 'Blocks placed on or after this instant.' })
  @IsISO8601()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({ description: 'Blocks placed before this instant.' })
  @IsISO8601()
  @IsOptional()
  to?: string;
}
