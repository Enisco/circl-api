import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ContentRiskTier,
  ContentScanStatus,
  ContentVisibilityState,
  ReportTargetType,
  RiskCategory,
} from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsISO8601, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { AdminPageOptionsDto, CsvArray } from '@/common';

export const FLAG_SORTS = ['score', 'createdAt', 'updatedAt'] as const;

/** §5.12's `admin/flags` query. Every filter is CSV, so a chip row sends one parameter. */
export class ListFlagsDto extends AdminPageOptionsDto {
  @ApiPropertyOptional({ enum: ContentRiskTier, isArray: true })
  @CsvArray()
  @IsEnum(ContentRiskTier, { each: true })
  @IsOptional()
  tier?: ContentRiskTier[];

  @ApiPropertyOptional({ enum: ContentVisibilityState, isArray: true })
  @CsvArray()
  @IsEnum(ContentVisibilityState, { each: true })
  @IsOptional()
  visibilityState?: ContentVisibilityState[];

  @ApiPropertyOptional({ enum: RiskCategory, isArray: true })
  @CsvArray()
  @IsEnum(RiskCategory, { each: true })
  @IsOptional()
  category?: RiskCategory[];

  @ApiPropertyOptional({ enum: ContentScanStatus, isArray: true })
  @CsvArray()
  @IsEnum(ContentScanStatus, { each: true })
  @IsOptional()
  scanStatus?: ContentScanStatus[];

  @ApiPropertyOptional({ enum: ReportTargetType, isArray: true })
  @CsvArray()
  @IsEnum(ReportTargetType, { each: true })
  @IsOptional()
  targetType?: ReportTargetType[];

  @ApiPropertyOptional({ description: 'Everything one member wrote that was scanned.' })
  @IsString()
  @IsOptional()
  authorId?: string;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 100,
    description: 'At or above this final score, for drilling into one band of the tier chart.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  @IsOptional()
  minScore?: number;

  @ApiPropertyOptional({ description: 'Scanned on or after this instant.' })
  @IsISO8601()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({ description: 'Scanned before this instant.' })
  @IsISO8601()
  @IsOptional()
  to?: string;

  @ApiPropertyOptional({ enum: FLAG_SORTS, default: 'score' })
  @IsIn([...FLAG_SORTS])
  @IsOptional()
  declare sort?: string;
}
