import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString } from 'class-validator';
import { SEARCH_DEPTHS, SEARCH_FILTERS, SearchFilter } from '../services/search-demand.service';

/**
 * The query for the published search lists.
 *
 * A DTO rather than three raw `@Query` params, because without one the endpoint took anything: an
 * unknown filter fell back to `ALL` and served the whole list to somebody who had asked for one
 * section, and a misspelt parameter name was ignored instead of named. Every other listing
 * endpoint here answers a typo with a 400 that says which field was wrong, and a silent wrong
 * answer is the worse of the two failures.
 */
export class SearchDemandQueryDto {
  @ApiPropertyOptional({
    enum: [...SEARCH_FILTERS],
    default: 'ALL',
    description: 'Which search box. `ALL` is the union of the five.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsIn([...SEARCH_FILTERS])
  @IsOptional()
  filter?: SearchFilter;

  @ApiPropertyOptional({ description: 'Omit for nationwide.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsOptional()
  cityId?: string;

  @ApiPropertyOptional({ enum: [...SEARCH_DEPTHS], default: SEARCH_DEPTHS[0] })
  @Type(() => Number)
  @IsInt()
  @IsIn([...SEARCH_DEPTHS])
  @IsOptional()
  limit?: number;
}
