import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DeliveryMode, ExperienceLevel, PriceBasis, Weekday } from '@prisma/client';
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
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ToBoolean } from '@/common';
import { SERVICE_LIMITS } from './service.dto';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
const Bool = ToBoolean;

/** One day of contactable hours (v2 §4.2). The same shape a store's opening hours use. */
export class ContactHoursDto {
  @ApiProperty({ enum: Weekday })
  @IsEnum(Weekday)
  day: Weekday;

  @ApiPropertyOptional({ minimum: 0, maximum: 1440, description: 'Minutes after midnight.' })
  @IsInt()
  @Min(0)
  @Max(1440)
  @IsOptional()
  openMinutes?: number | null;

  @ApiPropertyOptional({ minimum: 0, maximum: 1440 })
  @IsInt()
  @Min(0)
  @Max(1440)
  @IsOptional()
  closeMinutes?: number | null;
}

/** Step 1 of registration (2.6.1). */
export class CreateListingDto {
  @ApiPropertyOptional({
    type: [String],
    description:
      'Coded skills (v2 §4.1), `TaxonomyKind.SKILL`. Filterable and countable. Absent leaves them ' +
      'alone; `[]` clears them.',
  })
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @IsOptional()
  skillCodes?: string[];

  @ApiPropertyOptional({
    type: [String],
    description:
      'The member’s own words for work the vocabulary has not caught up with. Displayed exactly ' +
      'like a coded skill and **never** filterable, and never promoted into the taxonomy ' +
      'automatically — the admin portal surfaces the recurring ones for a human to decide.',
  })
  @IsArray()
  @ArrayMaxSize(3)
  @IsString({ each: true })
  @MaxLength(30, { each: true })
  @IsOptional()
  customSkills?: string[];

  @ApiPropertyOptional({ type: [ContactHoursDto], description: 'Seven entries, or none at all.' })
  @IsArray()
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => ContactHoursDto)
  @IsOptional()
  contactHours?: ContactHoursDto[];

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
  @Trim()
  @IsString()
  @IsOptional()
  cityId?: string;

  @ApiPropertyOptional({ enum: DeliveryMode, default: DeliveryMode.IN_PERSON })
  @IsEnum(DeliveryMode)
  @IsOptional()
  deliveryMode?: DeliveryMode;

  @ApiPropertyOptional({ description: 'Pence.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  priceFrom?: number;

  @ApiPropertyOptional({ enum: PriceBasis, default: PriceBasis.NEGOTIABLE })
  @IsEnum(PriceBasis)
  @IsOptional()
  priceBasis?: PriceBasis;

  @ApiPropertyOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
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
  @IsString()
  @IsOptional()
  sourceOfferId?: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      "A media key, upload purpose PROFESSIONAL. The listing's own photo, which is not the " +
      'account avatar: a personal photo is not always the right professional one, and a listing ' +
      'that is a small firm wants its logo. **Omit to leave the current one alone**; send `null` ' +
      "to remove it, after which the listing falls back to the member's avatar again.",
  })
  @IsString()
  @IsOptional()
  photoKey?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'A media key, upload purpose PROFESSIONAL. Absent leaves it alone, `null` removes it and ' +
      'the header keeps the gradient it has always had.',
  })
  @IsString()
  @IsOptional()
  coverKey?: string | null;

  @ApiPropertyOptional({
    type: [String],
    minItems: 1,
    maxItems: 5,
    description:
      'Media ids of 1 to 5 supporting documents (§2.9), **required** when any chosen profession ' +
      'has `requiresReview: true` on `GET /taxonomy` — a qualification, a registration, a licence ' +
      'or an insurance schedule. Upload them through `POST media/uploads` with ' +
      '`purpose: VERIFICATION`; PDF, PNG and JPEG only.\n\n' +
      'Sent for a profession that needs no approval: **400 `DOCUMENTS_NOT_REQUIRED`**. These are ' +
      'identity papers, and the platform does not keep ones it has no reason to hold.\n\n' +
      'On an edit this is the **whole** set, not an addition: anything attached and not listed ' +
      'here stops being part of the submission.',
  })
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @IsOptional()
  documentIds?: string[];
}

export class UpdateListingDto {
  @ApiPropertyOptional({
    type: [String],
    description:
      'Coded skills (v2 §4.1), `TaxonomyKind.SKILL`. Filterable and countable. Absent leaves them ' +
      'alone; `[]` clears them.',
  })
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @IsOptional()
  skillCodes?: string[];

  @ApiPropertyOptional({
    type: [String],
    description:
      'The member’s own words for work the vocabulary has not caught up with. Displayed exactly ' +
      'like a coded skill and **never** filterable, and never promoted into the taxonomy ' +
      'automatically — the admin portal surfaces the recurring ones for a human to decide.',
  })
  @IsArray()
  @ArrayMaxSize(3)
  @IsString({ each: true })
  @MaxLength(30, { each: true })
  @IsOptional()
  customSkills?: string[];

  @ApiPropertyOptional({ type: [ContactHoursDto], description: 'Seven entries, or none at all.' })
  @IsArray()
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => ContactHoursDto)
  @IsOptional()
  contactHours?: ContactHoursDto[];

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @IsString({ each: true })
  @IsOptional()
  categoryCodes?: string[];

  @ApiPropertyOptional({ minLength: 3, maxLength: 80 })
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(80)
  @IsOptional()
  professionTitle?: string;

  @ApiPropertyOptional({ enum: ExperienceLevel })
  @IsEnum(ExperienceLevel)
  @IsOptional()
  experienceLevel?: ExperienceLevel;

  @ApiPropertyOptional({ minLength: 20, maxLength: 4000 })
  @Trim()
  @IsString()
  @MinLength(20)
  @MaxLength(4000)
  @IsOptional()
  about?: string;

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

  @ApiPropertyOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  yearsExperience?: number;

  @ApiPropertyOptional()
  @Bool()
  @IsBoolean()
  @IsOptional()
  freeConsultation?: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description:
      "A media key, upload purpose PROFESSIONAL. The listing's own photo, which is not the " +
      'account avatar: a personal photo is not always the right professional one, and a listing ' +
      'that is a small firm wants its logo. **Omit to leave the current one alone**; send `null` ' +
      "to remove it, after which the listing falls back to the member's avatar again.",
  })
  @IsString()
  @IsOptional()
  photoKey?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'A media key, upload purpose PROFESSIONAL. Absent leaves it alone, `null` removes it and ' +
      'the header keeps the gradient it has always had.',
  })
  @IsString()
  @IsOptional()
  coverKey?: string | null;

  @ApiPropertyOptional({
    type: [String],
    minItems: 1,
    maxItems: 5,
    description:
      'Media ids of 1 to 5 supporting documents (§2.9), **required** when any chosen profession ' +
      'has `requiresReview: true` on `GET /taxonomy` — a qualification, a registration, a licence ' +
      'or an insurance schedule. Upload them through `POST media/uploads` with ' +
      '`purpose: VERIFICATION`; PDF, PNG and JPEG only.\n\n' +
      'Sent for a profession that needs no approval: **400 `DOCUMENTS_NOT_REQUIRED`**. These are ' +
      'identity papers, and the platform does not keep ones it has no reason to hold.\n\n' +
      'On an edit this is the **whole** set, not an addition: anything attached and not listed ' +
      'here stops being part of the submission.',
  })
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @IsOptional()
  documentIds?: string[];
}

/** All optional, each one overriding the offer's value (2.1.3). */
export class PromoteOfferDto {
  @ApiPropertyOptional({
    description:
      'The professional category, a different taxonomy from community categories. Usually the ' +
      'only field the member has to supply, because the community category suggests it.',
  })
  @Trim()
  @IsString()
  @IsOptional()
  professionCode?: string;

  @ApiPropertyOptional()
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(80)
  @IsOptional()
  title?: string;

  @ApiPropertyOptional()
  @Trim()
  @IsString()
  @MinLength(20)
  @MaxLength(4000)
  @IsOptional()
  about?: string;

  @ApiPropertyOptional()
  @Trim()
  @IsString()
  @IsOptional()
  cityId?: string;

  @ApiPropertyOptional({ enum: ExperienceLevel })
  @IsEnum(ExperienceLevel)
  @IsOptional()
  experienceLevel?: ExperienceLevel;

  @ApiPropertyOptional({ description: 'Must be true if the member has not already consented.' })
  @Bool()
  @IsBoolean()
  @IsOptional()
  consentAccepted?: boolean;

  @ApiPropertyOptional({
    type: [String],
    minItems: 1,
    maxItems: 5,
    description:
      'Media ids of 1 to 5 supporting documents (§2.9), **required** when any chosen profession ' +
      'has `requiresReview: true` on `GET /taxonomy` — a qualification, a registration, a licence ' +
      'or an insurance schedule. Upload them through `POST media/uploads` with ' +
      '`purpose: VERIFICATION`; PDF, PNG and JPEG only.\n\n' +
      'Sent for a profession that needs no approval: **400 `DOCUMENTS_NOT_REQUIRED`**. These are ' +
      'identity papers, and the platform does not keep ones it has no reason to hold.\n\n' +
      'On an edit this is the **whole** set, not an addition: anything attached and not listed ' +
      'here stops being part of the submission.',
  })
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @IsOptional()
  documentIds?: string[];
}

export class ServiceDto {
  @ApiProperty({ minLength: SERVICE_LIMITS.nameMin, maxLength: SERVICE_LIMITS.nameMax })
  @Trim()
  @IsString()
  @MinLength(SERVICE_LIMITS.nameMin)
  @MaxLength(SERVICE_LIMITS.nameMax)
  name: string;

  /**
   * The same ceiling as `CreateServiceDto`, which v2 raised to fifteen hundred (§3.5).
   *
   * Two shapes write a service — this one, nested in the listing, and the service endpoints — and a
   * description accepted by one and refused by the other is a member whose text saves from one
   * screen and not the other. The **minimum** is not here for the same reason it is not there: it
   * applies to writes that carry a category, and this shape has none.
   */
  @ApiPropertyOptional({ maxLength: SERVICE_LIMITS.descriptionMax })
  @Trim()
  @IsString()
  @MaxLength(SERVICE_LIMITS.descriptionMax)
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ description: 'Pence. Null means "on request".' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  price?: number;

  @ApiPropertyOptional({ enum: PriceBasis })
  @IsEnum(PriceBasis)
  @IsOptional()
  priceBasis?: PriceBasis;

  @ApiPropertyOptional({ default: true })
  @Bool()
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class UpdateServiceDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 80 })
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @Trim()
  @IsString()
  @MaxLength(500)
  @IsOptional()
  description?: string;

  @ApiPropertyOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  price?: number;

  @ApiPropertyOptional({ enum: PriceBasis })
  @IsEnum(PriceBasis)
  @IsOptional()
  priceBasis?: PriceBasis;

  @ApiPropertyOptional()
  @Bool()
  @IsBoolean()
  @IsOptional()
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
  @Bool()
  @IsBoolean()
  isAcceptingWork: boolean;
}
