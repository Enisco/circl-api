import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DeliveryMode, ExperienceLevel, PriceBasis } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
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

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
const Bool = () => Transform(({ value }) => value === true || value === 'true');

/**
 * Step 1 of registration (2.6.1).
 *
 * Deliberately absent: `name`, `phone`, `email`, `gender`, `avatar`,
 * `countryOfOrigin`. They are on the user record, and accepting them here is
 * what invites a client to ask for them again. Call
 * `GET /professionals/registration/prefill` first and do not ask for anything it
 * returned.
 */
export class CreateListingDto {
  @ApiProperty({ type: [String], description: '1 to 3 profession codes.' })
  @IsArray()
  @ArrayMinSize(1, { message: 'categoryCodes must have at least one entry' })
  @ArrayMaxSize(3, { message: 'categoryCodes must have 3 entries or fewer' })
  @IsString({ each: true })
  categoryCodes: string[];

  @ApiProperty({ minLength: 3, maxLength: 80 })
  @Trim()
  @IsString()
  @MinLength(3, { message: 'professionTitle must be at least 3 characters' })
  @MaxLength(80, { message: 'professionTitle must be 80 characters or fewer' })
  professionTitle: string;

  @ApiProperty({ enum: ExperienceLevel })
  @IsEnum(ExperienceLevel)
  experienceLevel: ExperienceLevel;

  @ApiProperty({
    minLength: 20,
    maxLength: 4000,
    description: 'Prefilled from profile.bio or profile.canHelpWith.',
  })
  @Trim()
  @IsString()
  @MinLength(20, { message: 'about must be at least 20 characters' })
  @MaxLength(4000, { message: 'about must be 4000 characters or fewer' })
  about: string;

  @ApiPropertyOptional({ description: "Defaults to the member's city. Prefilled, editable." })
  @Trim() @IsString() @IsOptional()
  cityId?: string;

  @ApiPropertyOptional({ enum: DeliveryMode, default: DeliveryMode.IN_PERSON })
  @IsEnum(DeliveryMode) @IsOptional()
  deliveryMode?: DeliveryMode;

  @ApiPropertyOptional({ description: 'Pence.' })
  @Type(() => Number) @IsInt() @Min(0) @IsOptional()
  priceFrom?: number;

  @ApiPropertyOptional({ enum: PriceBasis, default: PriceBasis.NEGOTIABLE })
  @IsEnum(PriceBasis) @IsOptional()
  priceBasis?: PriceBasis;

  @ApiPropertyOptional() @Type(() => Number) @IsInt() @Min(0) @IsOptional()
  yearsExperience?: number;

  @ApiProperty({
    description:
      'Must be true. With credential checks not shipping this release (D13), what was agreed and ' +
      'when is stored, so an unchecked claim is at least an unchecked claim that says so.',
  })
  @Bool()
  @IsBoolean()
  @Equals(true, { message: 'consentAccepted must be accepted to list as a professional' })
  consentAccepted: boolean;

  @ApiPropertyOptional({ description: 'Prefer POST /listings/from-offer/{id}.' })
  @IsString() @IsOptional()
  sourceOfferId?: string;
}

export class UpdateListingDto {
  @ApiPropertyOptional({ type: [String] })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(3) @IsString({ each: true }) @IsOptional()
  categoryCodes?: string[];

  @ApiPropertyOptional({ minLength: 3, maxLength: 80 })
  @Trim() @IsString() @MinLength(3) @MaxLength(80) @IsOptional()
  professionTitle?: string;

  @ApiPropertyOptional({ enum: ExperienceLevel })
  @IsEnum(ExperienceLevel) @IsOptional()
  experienceLevel?: ExperienceLevel;

  @ApiPropertyOptional({ minLength: 20, maxLength: 4000 })
  @Trim() @IsString() @MinLength(20) @MaxLength(4000) @IsOptional()
  about?: string;

  @ApiPropertyOptional() @Trim() @IsString() @IsOptional()
  cityId?: string;

  @ApiPropertyOptional({ enum: DeliveryMode })
  @IsEnum(DeliveryMode) @IsOptional()
  deliveryMode?: DeliveryMode;

  @ApiPropertyOptional() @Type(() => Number) @IsInt() @Min(0) @IsOptional()
  priceFrom?: number;

  @ApiPropertyOptional({ enum: PriceBasis })
  @IsEnum(PriceBasis) @IsOptional()
  priceBasis?: PriceBasis;

  @ApiPropertyOptional() @Type(() => Number) @IsInt() @Min(0) @IsOptional()
  yearsExperience?: number;

  @ApiPropertyOptional() @Bool() @IsBoolean() @IsOptional()
  freeConsultation?: boolean;
}

/** All optional, each one overriding the offer's value (2.1.3). */
export class PromoteOfferDto {
  @ApiPropertyOptional({
    description:
      'The professional category, a different taxonomy from community categories. Usually the ' +
      'only field the member has to supply, because the community category suggests it.',
  })
  @Trim() @IsString() @IsOptional()
  professionCode?: string;

  @ApiPropertyOptional() @Trim() @IsString() @MinLength(3) @MaxLength(80) @IsOptional()
  title?: string;

  @ApiPropertyOptional() @Trim() @IsString() @MinLength(20) @MaxLength(4000) @IsOptional()
  about?: string;

  @ApiPropertyOptional() @Trim() @IsString() @IsOptional()
  cityId?: string;

  @ApiPropertyOptional({ enum: ExperienceLevel })
  @IsEnum(ExperienceLevel) @IsOptional()
  experienceLevel?: ExperienceLevel;

  @ApiPropertyOptional({ description: 'Must be true if the member has not already consented.' })
  @Bool() @IsBoolean() @IsOptional()
  consentAccepted?: boolean;
}

export class ServiceDto {
  @ApiProperty({ minLength: 2, maxLength: 80 })
  @Trim() @IsString() @MinLength(2) @MaxLength(80)
  name: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @Trim() @IsString() @MaxLength(500) @IsOptional()
  description?: string;

  @ApiPropertyOptional({ description: 'Pence. Null means "on request".' })
  @Type(() => Number) @IsInt() @Min(0) @IsOptional()
  price?: number;

  @ApiPropertyOptional({ enum: PriceBasis })
  @IsEnum(PriceBasis) @IsOptional()
  priceBasis?: PriceBasis;

  @ApiPropertyOptional({ default: true })
  @Bool() @IsBoolean() @IsOptional()
  isActive?: boolean;
}

export class UpdateServiceDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 80 })
  @Trim() @IsString() @MinLength(2) @MaxLength(80) @IsOptional()
  name?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @Trim() @IsString() @MaxLength(500) @IsOptional()
  description?: string;

  @ApiPropertyOptional() @Type(() => Number) @IsInt() @Min(0) @IsOptional()
  price?: number;

  @ApiPropertyOptional({ enum: PriceBasis })
  @IsEnum(PriceBasis) @IsOptional()
  priceBasis?: PriceBasis;

  @ApiPropertyOptional() @Bool() @IsBoolean() @IsOptional()
  isActive?: boolean;
}

export class ReplaceServicesDto {
  @ApiProperty({ type: [ServiceDto], description: "The manage panel's bulk save." })
  @IsArray()
  @ArrayMaxSize(30)
  services: ServiceDto[];
}

export class AvailabilityDto {
  @ApiProperty()
  @Bool() @IsBoolean()
  isAcceptingWork: boolean;
}
