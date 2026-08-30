import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export const SEARCH_SCOPES = ['ALL', 'COMMUNITY', 'PROFESSIONALS', 'CONNECT', 'COMMERCE'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

export class SearchDto {
  @ApiPropertyOptional({ description: 'Shorter than two characters returns empty groups, not an error.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsOptional()
  q?: string;

  @ApiPropertyOptional({ enum: SEARCH_SCOPES, default: 'ALL' })
  @IsIn(SEARCH_SCOPES)
  @IsOptional()
  scope?: SearchScope;

  @ApiPropertyOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsOptional()
  cityId?: string;

  @ApiPropertyOptional({ default: 10, maximum: 25 })
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(25)
  @IsOptional()
  limit?: number;
}
