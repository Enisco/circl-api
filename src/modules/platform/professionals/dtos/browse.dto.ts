import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { PageOptionsDto } from '@/common';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
const Bool = () => Transform(({ value }) => value === true || value === 'true');
const CsvArray = () =>
  Transform(({ value }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map(v => v.trim())
          .filter(Boolean)
      : value,
  );

export class BrowseProfessionalsDto extends PageOptionsDto {
  @ApiPropertyOptional({ description: 'A profession code. "All" omits the param.' })
  @Trim()
  @IsString()
  @IsOptional()
  category?: string;

  @ApiPropertyOptional({ description: 'Name, profession title, city, category.' })
  @Trim()
  @IsString()
  @IsOptional()
  q?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  cityId?: string;

  @ApiPropertyOptional({ description: 'Requires a location permission the client primes first.' })
  @Bool()
  @IsBoolean()
  @IsOptional()
  nearMe?: boolean;

  @ApiPropertyOptional({ description: 'Only meaningful with nearMe.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  @IsOptional()
  radiusMiles?: number;

  @ApiPropertyOptional({ description: 'The device latitude, sent only when nearMe is set.' })
  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  latitude?: number;

  @ApiPropertyOptional()
  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  longitude?: number;

  @ApiPropertyOptional({ example: 4.5 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(5)
  @IsOptional()
  minRating?: number;

  @ApiPropertyOptional({ enum: ['AVAILABLE_NOW', 'ACCEPTING_BOOKINGS'] })
  @IsIn(['AVAILABLE_NOW', 'ACCEPTING_BOOKINGS'])
  @IsOptional()
  availability?: 'AVAILABLE_NOW' | 'ACCEPTING_BOOKINGS';

  @ApiPropertyOptional({ description: '24 backs "Replies within a day".' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  maxResponseHours?: number;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Comma list of TrustCheck codes. Inactive this version (D13): GET /taxonomy reports ' +
      'filters.verification.isActive false and the client hides the row, because with no checks ' +
      'written nothing would ever match it.',
  })
  @CsvArray()
  @IsArray()
  @IsOptional()
  verification?: string[];

  @ApiPropertyOptional({
    description:
      'D11: reviewers whose country of origin is set and is not the UK, at 3 or more such reviews ' +
      'averaging 4 stars or above. The rule text ships in GET /taxonomy so the copy beside the ' +
      'filter and the query cannot drift apart.',
  })
  @Bool()
  @IsBoolean()
  @IsOptional()
  immigrantFriendly?: boolean;

  @ApiPropertyOptional({
    enum: ['PROFESSIONAL', 'COMMUNITY_OFFER', 'BOTH'],
    default: 'PROFESSIONAL',
    description:
      'BOTH merges listings and community offers into one result set, each carrying its own ' +
      '`type` so the client renders the grey "Community offer" chip and swaps the action to ' +
      'Message (D14).',
  })
  @IsIn(['PROFESSIONAL', 'COMMUNITY_OFFER', 'BOTH'])
  @IsOptional()
  listingType?: 'PROFESSIONAL' | 'COMMUNITY_OFFER' | 'BOTH';

  @ApiPropertyOptional({ description: 'Pence.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  maxPrice?: number;

  @ApiPropertyOptional()
  @Bool()
  @IsBoolean()
  @IsOptional()
  freeConsultation?: boolean;

  @ApiPropertyOptional({
    enum: ['RECOMMENDED', 'RATING', 'REVIEWS', 'NEAREST', 'PRICE', 'RESPONSE'],
    default: 'RECOMMENDED',
  })
  @IsIn(['RECOMMENDED', 'RATING', 'REVIEWS', 'NEAREST', 'PRICE', 'RESPONSE'])
  @IsOptional()
  sort?: 'RECOMMENDED' | 'RATING' | 'REVIEWS' | 'NEAREST' | 'PRICE' | 'RESPONSE';
}
