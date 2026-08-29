import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DmPolicy } from '@prisma/client';
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

/** One idempotent upsert for both create and edit, because the setup screen is the same screen either way (3.3.1). */
export class UpsertConnectProfileDto {
  @ApiProperty({
    description: 'A connection type code: FRIENDSHIP, NETWORKING, LANGUAGE_EXCHANGE, and so on.',
  })
  @Trim()
  @IsString()
  typeCode: string;

  @ApiProperty({ minLength: 10, maxLength: 500, description: 'The form blocks below 10.' })
  @Trim()
  @IsString()
  @MinLength(10, { message: 'lookingFor must be at least 10 characters' })
  @MaxLength(500, { message: 'lookingFor must be 500 characters or fewer' })
  lookingFor: string;

  @ApiPropertyOptional({ enum: DmPolicy, default: DmPolicy.REQUEST_FIRST })
  @IsEnum(DmPolicy)
  @IsOptional()
  dmPolicy?: DmPolicy;

  @ApiPropertyOptional({
    default: false,
    description: 'Off by default. Opting in to be discoverable is a deliberate act.',
  })
  @Bool()
  @IsBoolean()
  @IsOptional()
  isVisible?: boolean;

  @ApiPropertyOptional({
    description:
      'Only when the user has none. Rejected with DOB_LOCKED otherwise, because it is an age gate.',
  })
  @IsDateString()
  @IsOptional()
  dateOfBirth?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Max 6. Prefilled, and written through to the USER record (3.1.3).',
  })
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  @IsOptional()
  languages?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'Max 8. Prefilled, and written through to the user — these also shape the feed.',
  })
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  @IsOptional()
  interests?: string[];

  @ApiPropertyOptional({ description: 'One heritage code. Written through to the user.' })
  @Trim()
  @IsString()
  @IsOptional()
  heritageTag?: string;

  @ApiPropertyOptional({
    description:
      'Only if the member wants to be found in a city they are moving to. Never touches ' +
      'profile.cityId, which the rest of the app trusts (D18).',
  })
  @Trim()
  @IsString()
  @IsOptional()
  cityIdOverride?: string;

  @ApiPropertyOptional({
    description:
      'Required when typeCode is DATING. The client shows an extra confirm step reiterating 18+ ' +
      'and the safety block, and the server records that the confirmation was given and when.',
  })
  @Bool()
  @IsBoolean()
  @IsOptional()
  datingConfirmed?: boolean;
}

export class DiscoveryDto extends PageOptionsDto {
  @ApiPropertyOptional({ description: 'A connection type code.' })
  @Trim()
  @IsString()
  @IsOptional()
  type?: string;

  @ApiPropertyOptional({ description: 'Clamped to 18 whatever is sent.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(120)
  @IsOptional()
  minAge?: number;

  @ApiPropertyOptional()
  @Type(() => Number)
  @IsInt()
  @Min(18)
  @Max(120)
  @IsOptional()
  maxAge?: number;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  cityId?: string;

  @ApiPropertyOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  radiusMiles?: number;

  @ApiPropertyOptional({
    type: [String],
    description: 'Matches if the profile speaks ANY of them.',
  })
  @CsvArray()
  @IsArray()
  @IsOptional()
  languages?: string[];

  @ApiPropertyOptional({ type: [String] })
  @CsvArray()
  @IsArray()
  @IsOptional()
  heritage?: string[];

  @ApiPropertyOptional({
    description:
      'Journey stage PLANNING or JUST_ARRIVED. Defined once server-side, so the chip and the query ' +
      'cannot drift.',
  })
  @Bool()
  @IsBoolean()
  @IsOptional()
  newToUk?: boolean;

  @ApiPropertyOptional({
    description:
      'Accepted but hidden in the client this version (D13): nothing carries an identity check yet, ' +
      'so the filter would always return nothing.',
  })
  @Bool()
  @IsBoolean()
  @IsOptional()
  verifiedOnly?: boolean;

  @ApiPropertyOptional({ enum: ['RECOMMENDED', 'RECENT', 'NEAREST'], default: 'RECOMMENDED' })
  @IsIn(['RECOMMENDED', 'RECENT', 'NEAREST'])
  @IsOptional()
  sort?: 'RECOMMENDED' | 'RECENT' | 'NEAREST';
}

export class CreateConnectionRequestDto {
  @ApiProperty()
  @Trim()
  @IsString()
  toProfileId: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @Trim()
  @IsString()
  @MaxLength(300)
  @IsOptional()
  note?: string;
}

export class ListConnectionRequestsDto extends PageOptionsDto {
  @ApiPropertyOptional({ enum: ['RECEIVED', 'SENT'], default: 'RECEIVED' })
  @IsIn(['RECEIVED', 'SENT'])
  @IsOptional()
  direction?: 'RECEIVED' | 'SENT';

  @ApiPropertyOptional({
    enum: ['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'ALL'],
    default: 'PENDING',
  })
  @IsIn(['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'ALL'])
  @IsOptional()
  state?: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'ALL';
}

export class DeclineRequestDto {
  @ApiPropertyOptional({
    default: false,
    description: "The decline sheet's second option. Applied in the same transaction.",
  })
  @Bool()
  @IsBoolean()
  @IsOptional()
  alsoBlock?: boolean;
}
