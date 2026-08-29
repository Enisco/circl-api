import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DeliveryMode, PriceBasis } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
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

/** Two composers post here: "Post a Request" in "I can help" mode (short form) and "Post a Service" (full form with delivery and price) — they differ only in which optional fields they fill (1.4.3). */
export class CreateOfferDto {
  @ApiProperty({ minLength: 6, maxLength: 120 })
  @Trim()
  @IsString()
  @MinLength(6, { message: 'title must be at least 6 characters' })
  @MaxLength(120, { message: 'title must be 120 characters or fewer' })
  title: string;

  @ApiProperty({ minLength: 20, maxLength: 4000 })
  @Trim()
  @IsString()
  @MinLength(20, { message: 'description must be at least 20 characters' })
  @MaxLength(4000, { message: 'description must be 4000 characters or fewer' })
  description: string;

  @ApiProperty({ example: 'AIRPORT_PICKUP' })
  @Trim()
  @IsString()
  categoryCode: string;

  @ApiProperty({ example: 'MANCHESTER' })
  @Trim()
  @IsString()
  cityId: string;

  @ApiPropertyOptional({ enum: DeliveryMode, default: DeliveryMode.IN_PERSON })
  @IsEnum(DeliveryMode)
  @IsOptional()
  deliveryMode?: DeliveryMode;

  @ApiPropertyOptional({ description: 'Pence. Omit or null means free.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  priceFrom?: number;

  @ApiPropertyOptional({
    enum: PriceBasis,
    default: PriceBasis.NEGOTIABLE,
    description: 'Ignored when priceFrom is null.',
  })
  @IsEnum(PriceBasis)
  @IsOptional()
  priceBasis?: PriceBasis;

  @ApiPropertyOptional({ type: [String], description: 'Max 5 images.' })
  @IsArray()
  @ArrayMaxSize(5)
  @IsOptional()
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  mediaKeys?: string[];
}

export class UpdateOfferDto {
  @ApiPropertyOptional({ minLength: 6, maxLength: 120 })
  @Trim()
  @IsString()
  @MinLength(6)
  @MaxLength(120)
  @IsOptional()
  title?: string;

  @ApiPropertyOptional({ minLength: 20, maxLength: 4000 })
  @Trim()
  @IsString()
  @MinLength(20)
  @MaxLength(4000)
  @IsOptional()
  description?: string;

  @ApiPropertyOptional()
  @Trim()
  @IsString()
  @IsOptional()
  categoryCode?: string;

  @ApiPropertyOptional()
  @Trim()
  @IsString()
  @IsOptional()
  cityId?: string;

  @ApiPropertyOptional({ enum: DeliveryMode })
  @IsEnum(DeliveryMode)
  @IsOptional()
  deliveryMode?: DeliveryMode;

  @ApiPropertyOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  priceFrom?: number;

  @ApiPropertyOptional({ enum: PriceBasis })
  @IsEnum(PriceBasis)
  @IsOptional()
  priceBasis?: PriceBasis;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @ArrayMaxSize(5)
  @IsOptional()
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  mediaKeys?: string[];
}

export class ListOffersDto extends PageOptionsDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  cityId?: string;

  @ApiPropertyOptional({ deprecated: true, description: 'Deprecated city name (1.0.3).' })
  @IsString()
  @IsOptional()
  city?: string;

  @ApiPropertyOptional({ type: [String] })
  @CsvArray()
  @IsArray()
  @IsOptional()
  categories?: string[];

  @ApiPropertyOptional({ enum: DeliveryMode })
  @IsEnum(DeliveryMode)
  @IsOptional()
  deliveryMode?: DeliveryMode;

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
  freeOnly?: boolean;

  @ApiPropertyOptional()
  @Trim()
  @IsString()
  @IsOptional()
  q?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  authorId?: string;
}
