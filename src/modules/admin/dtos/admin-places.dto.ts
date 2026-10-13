import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ToBoolean } from '@/common';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class ListCitiesDto {
  @ApiPropertyOptional({ description: 'Matches the id or the name.' })
  @Trim()
  @IsString()
  @MaxLength(80)
  @IsOptional()
  q?: string;

  @ApiPropertyOptional()
  @Trim()
  @IsString()
  @MaxLength(80)
  @IsOptional()
  region?: string;

  @ApiPropertyOptional({ description: 'Omit for both.' })
  @ToBoolean()
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class CreateCityDto {
  @ApiProperty({
    example: 'MILTON_KEYNES',
    description:
      'UPPER_SNAKE, and **permanent**: content references it, so a city is never renamed — only ' +
      'deactivated.',
  })
  @Trim()
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @Matches(/^[A-Z][A-Z0-9_]{1,39}$/, {
    message: 'id must be UPPER_SNAKE_CASE, 2–40 characters, starting with a letter.',
  })
  id: string;

  @ApiProperty({ example: 'Milton Keynes' })
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name: string;

  @ApiPropertyOptional({ example: 'South East', description: 'Rendered beside the name.' })
  @Trim()
  @IsString()
  @MaxLength(80)
  @IsOptional()
  region?: string;

  @ApiPropertyOptional({ description: 'Used by “near me” and the brief distance scores.' })
  @IsLatitude()
  @IsOptional()
  latitude?: number;

  @ApiPropertyOptional()
  @IsLongitude()
  @IsOptional()
  longitude?: number;

  @ApiPropertyOptional({ default: 'Europe/London' })
  @Trim()
  @IsString()
  @MaxLength(64)
  @IsOptional()
  timezone?: string;
}

export class UpdateCityDto {
  @ApiPropertyOptional()
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ nullable: true })
  @Transform(({ value }) => (value === '' || value === null ? null : value))
  @IsString()
  @MaxLength(80)
  @IsOptional()
  region?: string | null;

  @ApiPropertyOptional()
  @IsLatitude()
  @IsOptional()
  latitude?: number;

  @ApiPropertyOptional()
  @IsLongitude()
  @IsOptional()
  longitude?: number;

  @ApiPropertyOptional({
    description:
      'Deactivating hides it from every picker. Content already filed against it still resolves ' +
      'to a name, because nothing is deleted from a list that has shipped.',
  })
  @ToBoolean()
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class ListSupportResourcesDto {
  @ApiPropertyOptional({ default: 'GB' })
  @Trim()
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsString()
  @MaxLength(2)
  @IsOptional()
  countryCode?: string;

  @ApiPropertyOptional()
  @ToBoolean()
  @IsBoolean()
  @IsOptional()
  isCrisis?: boolean;

  @ApiPropertyOptional()
  @ToBoolean()
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class UpsertSupportResourceDto {
  @ApiProperty({ example: 'Samaritans' })
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional({ example: '116 123', description: 'As a member would dial it.' })
  @Trim()
  @IsString()
  @MaxLength(40)
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({ maxLength: 500, description: 'What this line is for, in plain words.' })
  @Trim()
  @IsString()
  @MaxLength(500)
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ description: 'https only.' })
  @Trim()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(500)
  @IsOptional()
  url?: string;

  @ApiPropertyOptional({ example: '24 hours, every day' })
  @Trim()
  @IsString()
  @MaxLength(120)
  @IsOptional()
  hours?: string;

  @ApiProperty({
    description:
      'A crisis line is listed first, above the “other places that can help” heading. It is also ' +
      'what the force-update gate lets through on an old build.',
  })
  @ToBoolean()
  @IsBoolean()
  isCrisis: boolean;

  @ApiPropertyOptional({ minimum: 0, maximum: 1000 })
  @IsInt()
  @Min(0)
  @Max(1000)
  @IsOptional()
  sort?: number;

  @ApiPropertyOptional({ default: 'GB' })
  @Trim()
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsString()
  @MaxLength(2)
  @IsOptional()
  countryCode?: string;
}

export class PatchSupportResourceDto extends UpsertSupportResourceDto {
  @ApiPropertyOptional()
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @IsOptional()
  declare name: string;

  @ApiPropertyOptional()
  @ToBoolean()
  @IsBoolean()
  @IsOptional()
  declare isCrisis: boolean;

  @ApiPropertyOptional()
  @ToBoolean()
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiPropertyOptional({
    enum: ['now'],
    description:
      'Send `now` to stamp today as the date the list was verified. The app renders it as “last ' +
      'checked”, which is the only thing telling a member in trouble that these numbers are ' +
      'current — so it is set deliberately rather than moved by any edit.',
  })
  @IsIn(['now'])
  @IsOptional()
  lastCheckedAt?: 'now';
}
