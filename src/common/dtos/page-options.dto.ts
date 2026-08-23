import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Standard paging (spec 0.5). Every collection endpoint is paginated; there are
 * no unbounded lists.
 *
 * `limit` clamps above 50 rather than erroring, because a client asking for 100
 * wants as many as it can have, not a 400.
 */
export class PageOptionsDto {
  static readonly DEFAULT_LIMIT = 20;
  static readonly MAX_LIMIT = 50;

  @ApiPropertyOptional({ description: 'Page number', example: 1, default: 1, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  readonly page?: number = 1;

  @ApiPropertyOptional({
    description: 'Items per page. Values above 50 are clamped to 50.',
    example: 20,
    default: 20,
    minimum: 1,
    maximum: 50,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  readonly limit?: number = PageOptionsDto.DEFAULT_LIMIT;

  /** The effective limit after clamping, which is what `meta.perPage` echoes. */
  get perPage(): number {
    return Math.min(this.limit ?? PageOptionsDto.DEFAULT_LIMIT, PageOptionsDto.MAX_LIMIT);
  }

  get currentPage(): number {
    return Math.max(this.page ?? 1, 1);
  }

  get skip(): number {
    return (this.currentPage - 1) * this.perPage;
  }

  get take(): number {
    return this.perPage;
  }
}

/**
 * The feed's cursor paging (0.5). Opaque to the client, which only ever echoes it
 * back.
 */
export class CursorOptionsDto {
  @ApiPropertyOptional({ description: 'Opaque cursor. Omit for the first page.' })
  @IsOptional()
  readonly cursor?: string;

  @ApiPropertyOptional({ description: 'Items per page', example: 20, default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  readonly limit?: number = 20;

  get take(): number {
    return Math.min(this.limit ?? 20, 50);
  }
}
