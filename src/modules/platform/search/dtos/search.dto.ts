import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** Every type `GET /search` can return. Each one is the row that type's own list endpoint returns. */
export const SEARCH_TYPES = [
  'REQUEST',
  'GUIDE',
  'GROUP',
  'PERSON',
  'CONNECT_PROFILE',
  'PROFESSIONAL',
  'STORE',
  'ITEM',
] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

/** @deprecated Superseded by `types`. Kept so an older build keeps working. */
export const SEARCH_SCOPES = ['ALL', 'COMMUNITY', 'PROFESSIONALS', 'CONNECT', 'COMMERCE'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
const CsvArray = () =>
  Transform(({ value }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map(entry => entry.trim().toUpperCase())
          .filter(Boolean)
      : value,
  );

export class SearchDto {
  @ApiPropertyOptional({
    description: 'Shorter than two characters returns empty groups, not an error.',
    example: 'visa',
  })
  @Trim()
  @IsString()
  @IsOptional()
  q?: string;

  @ApiPropertyOptional({
    description:
      'Comma-separated type codes. Defaults to every type the caller may see.\n\n' +
      'Unknown codes are **ignored, not rejected**, so retiring a type never breaks an older ' +
      'build of the app, and a new type can ship server-first.\n\n' +
      `Known codes: ${SEARCH_TYPES.join(', ')}.`,
    example: 'REQUEST,GUIDE,GROUP,PERSON',
  })
  @CsvArray()
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  types?: string[];

  @ApiPropertyOptional({
    enum: SEARCH_SCOPES,
    deprecated: true,
    description:
      'Superseded by `types`. Section composition is a client concern and it moves; holding the ' +
      'mapping here made every chip change a backend deploy. Ignored when `types` is sent.',
  })
  @IsIn(SEARCH_SCOPES)
  @IsOptional()
  scope?: SearchScope;

  @ApiPropertyOptional({
    description:
      'Biases the ranking towards a city. It does **not** filter: someone searching "visa" in ' +
      'London should see the London request first, not only London requests. Defaults to the ' +
      "caller's own city.",
    example: 'LONDON',
  })
  @Trim()
  @IsString()
  @IsOptional()
  cityId?: string;

  @ApiPropertyOptional({
    default: 3,
    maximum: 25,
    description:
      'Rows **per type**, not overall. The response is grouped, so one overall limit would let a ' +
      'popular type starve the rest.',
  })
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(25)
  @IsOptional()
  limit?: number;
}
