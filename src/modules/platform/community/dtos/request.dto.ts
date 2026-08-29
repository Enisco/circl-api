import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PostVisibility, RequestStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PageOptionsDto } from '@/common';

/** All string fields are trimmed before validation, and a whitespace-only value counts as empty (1.11). */
const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

const CsvArray = () =>
  Transform(({ value }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map(part => part.trim())
          .filter(Boolean)
      : value,
  );

export class CreateRequestDto {
  @ApiProperty({ example: 'VISA_DOCS', description: 'A code from `communityCategories`.' })
  @Trim()
  @IsString()
  categoryCode: string;

  @ApiProperty({ example: 'Need help understanding my CoS letter', minLength: 6, maxLength: 120 })
  @Trim()
  @IsString()
  @MinLength(6, { message: 'title must be at least 6 characters' })
  @MaxLength(120, { message: 'title must be 120 characters or fewer' })
  title: string;

  @ApiPropertyOptional({ maxLength: 4000 })
  @Trim()
  @IsString()
  @MaxLength(4000, { message: 'description must be 4000 characters or fewer' })
  @IsOptional()
  description?: string;

  @ApiProperty({ example: 'MANCHESTER', description: "Defaults client-side to the member's city." })
  @Trim()
  @IsString()
  cityId: string;

  @ApiPropertyOptional({ example: '2026-04-20', description: 'YYYY-MM-DD. Not in the past.' })
  @IsDateString({}, { message: 'neededOn must be a date in YYYY-MM-DD format' })
  @IsOptional()
  neededOn?: string;

  @ApiPropertyOptional({
    example: 2000,
    description:
      'Pence. A voluntary amount the poster offers. Circl does not process it — it is a number ' +
      'displayed as a chip (D4).',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0, { message: 'thankYouAmount must not be negative' })
  @Max(100_000, { message: 'thankYouAmount must be £1000 or less' })
  @IsOptional()
  thankYouAmount?: number;

  @ApiPropertyOptional({
    enum: [PostVisibility.PUBLIC, PostVisibility.ANONYMOUS],
    default: PostVisibility.PUBLIC,
    description:
      'PRIVATE_TO_CIRCL is rejected here with USE_PRIVATE_ENDPOINT; the client routes to the ' +
      'private composer instead (1.9).',
  })
  @IsEnum(PostVisibility)
  @IsOptional()
  visibility?: PostVisibility;

  @ApiPropertyOptional({ type: [String], description: 'Max 5 images or 1 video, never both.' })
  @IsArray()
  @ArrayMaxSize(5)
  @IsOptional()
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  mediaKeys?: string[];
}

export class UpdateRequestDto {
  @ApiPropertyOptional()
  @Trim()
  @IsString()
  @IsOptional()
  categoryCode?: string;

  @ApiPropertyOptional({ minLength: 6, maxLength: 120 })
  @Trim()
  @IsString()
  @MinLength(6)
  @MaxLength(120)
  @IsOptional()
  title?: string;

  @ApiPropertyOptional({ maxLength: 4000 })
  @Trim()
  @IsString()
  @MaxLength(4000)
  @IsOptional()
  description?: string;

  @ApiPropertyOptional()
  @Trim()
  @IsString()
  @IsOptional()
  cityId?: string;

  @ApiPropertyOptional({ example: '2026-04-20' })
  @IsDateString()
  @IsOptional()
  neededOn?: string;

  @ApiPropertyOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000)
  @IsOptional()
  thankYouAmount?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @ArrayMaxSize(5)
  @IsOptional()
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  mediaKeys?: string[];
}

export class ListRequestsDto extends PageOptionsDto {
  @ApiPropertyOptional({ description: "Defaults to the viewer's city. `ANYWHERE` for all cities." })
  @IsString()
  @IsOptional()
  cityId?: string;

  @ApiPropertyOptional({
    deprecated: true,
    description:
      'Deprecated (1.0.3). City name, case-insensitive, accepted for one release while the client ' +
      'migrates to cityId. If both are sent, cityId wins.',
  })
  @IsString()
  @IsOptional()
  city?: string;

  @ApiPropertyOptional({
    enum: [...Object.values(RequestStatus), 'ALL'],
    default: RequestStatus.OPEN,
    description: 'CLOSED matches RESOLVED, CLOSED and EXPIRED, which is what the filter row means.',
  })
  @IsString()
  @IsOptional()
  status?: RequestStatus | 'ALL';

  @ApiPropertyOptional({ type: [String], description: 'Comma-separated category codes.' })
  @CsvArray()
  @IsArray()
  @IsOptional()
  categories?: string[];

  @ApiPropertyOptional({ description: "Restricts to the viewer's city and sorts by proximity." })
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  @IsOptional()
  nearYou?: boolean;

  @ApiPropertyOptional({ description: "A member's requests, for their community profile." })
  @IsString()
  @IsOptional()
  authorId?: string;

  @ApiPropertyOptional({ description: 'Free text over title and description.' })
  @Trim()
  @IsString()
  @IsOptional()
  q?: string;

  @ApiPropertyOptional({ enum: ['RECENT', 'MOST_HELPERS', 'NEEDED_SOONEST'], default: 'RECENT' })
  @IsIn(['RECENT', 'MOST_HELPERS', 'NEEDED_SOONEST'])
  @IsOptional()
  sort?: 'RECENT' | 'MOST_HELPERS' | 'NEEDED_SOONEST';
}

export class ResolveRequestDto {
  @ApiPropertyOptional({
    type: [String],
    description:
      'Multi-select from the response thread. An empty array is valid: the member may have been ' +
      'helped by nobody in-app.',
  })
  @IsArray()
  @ArrayMaxSize(20)
  @IsOptional()
  helperUserIds?: string[];

  @ApiPropertyOptional({
    enum: ['HELPED', 'SOLVED_ELSEWHERE', 'NO_LONGER_NEEDED'],
    default: 'HELPED',
    description: 'Feeds the Pulse metric "questions we still cannot answer".',
  })
  @IsIn(['HELPED', 'SOLVED_ELSEWHERE', 'NO_LONGER_NEEDED'])
  @IsOptional()
  outcome?: 'HELPED' | 'SOLVED_ELSEWHERE' | 'NO_LONGER_NEEDED';
}
