import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MediaRole, PriceBasis } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PageOptionsDto } from '@/common';
import { PROFESSIONAL_SORTS, ProfessionalSort } from './browse.dto';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/** §3.5's service limits, which the taxonomy also serves so a change needs no release. */
export const SERVICE_LIMITS = {
  nameMin: 2,
  nameMax: 80,
  descriptionMin: 40,
  descriptionMax: 1500,
  media: 10,
  videos: 3,
  updates: 10,
  updateBody: 280,
  updateTitle: 80,
  milestones: 6,
  milestoneLabel: 80,
  /** How many services one listing may hold. Asked for by §8: tell us the number. */
  perListing: 30,
} as const;

/** One attachment and what it is *of* (§5.5, §9.1). */
export class ServiceMediaKeyDto {
  @ApiProperty({ description: 'The storage key the upload returned.' })
  @IsString()
  key: string;

  @ApiPropertyOptional({ enum: MediaRole, default: MediaRole.SHOWCASE })
  @IsEnum(MediaRole)
  @IsOptional()
  role?: MediaRole;
}

export class ServiceUpdateDto {
  @ApiPropertyOptional({ maxLength: SERVICE_LIMITS.updateTitle })
  @Trim()
  @IsString()
  @MaxLength(SERVICE_LIMITS.updateTitle)
  @IsOptional()
  title?: string;

  @ApiProperty({ maxLength: SERVICE_LIMITS.updateBody })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(SERVICE_LIMITS.updateBody)
  body: string;
}

export class ServiceMilestoneDto {
  @ApiProperty({ maxLength: SERVICE_LIMITS.milestoneLabel })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(SERVICE_LIMITS.milestoneLabel)
  label: string;

  @ApiPropertyOptional({ description: 'Nullable. An absent year renders the claim alone.' })
  @IsInt()
  @Min(1900)
  @Max(2100)
  @IsOptional()
  year?: number;

  @ApiPropertyOptional({ maxLength: 80 })
  @Trim()
  @IsString()
  @MaxLength(80)
  @IsOptional()
  issuer?: string;
}

/**
 * §5.5's create body.
 *
 * `description` and `categoryCode` are required here and nullable on read: a service written
 * before v2 has neither, and rendering it without a description is better than hiding somebody's
 * live work (§10).
 */
export class CreateServiceDto {
  @ApiProperty({ minLength: SERVICE_LIMITS.nameMin, maxLength: SERVICE_LIMITS.nameMax })
  @Trim()
  @IsString()
  // The same two-to-eighty a service name has always had. v2 widened the description and said
  // nothing about the name, and quietly moving a limit an older build's form still enforces is how
  // a client ends up refusing what the server accepts.
  @MinLength(SERVICE_LIMITS.nameMin)
  @MaxLength(SERVICE_LIMITS.nameMax)
  name: string;

  @ApiProperty({
    minLength: SERVICE_LIMITS.descriptionMin,
    maxLength: SERVICE_LIMITS.descriptionMax,
    description: 'Required on a v2 write — one that carries `categoryCode`. See the note below.',
  })
  /**
   * The **minimum** is checked by the service, not here, because it applies to v2 writes only.
   *
   * A decorator fires whenever the field is present, and an older build sending a twenty-character
   * description would be refused by it — which is the strand §10 forbids. The ceiling stays here:
   * fifteen hundred characters is a storage rule and applies to everybody.
   */
  @Trim()
  @IsString()
  @MaxLength(SERVICE_LIMITS.descriptionMax)
  @IsOptional()
  description?: string;

  /**
   * **Back-compat, and the one place v2's rules bend** (§10: *do not strand it*).
   *
   * A build older than this change sends `{ name, description?, price?, priceBasis?, isActive? }`
   * and knows nothing about categories, pence or statuses. Those members are live right now, and
   * refusing their price list until they update the app would be the worst possible reading of a
   * backwards-compatible change.
   *
   * So the shape a request arrives in decides which rules apply. One carrying `categoryCode` is a
   * v2 write and every v2 rule holds: description length, a price in pence, a subcategory where
   * the category has children, and the verification gate. One without it is a legacy write — the
   * category is backfilled from the listing's primary, `price` is read in place of `pricePence`,
   * and it publishes if that category is ungated. `ServiceCatalogueService` enforces the
   * difference; this class only has to let both through the door.
   */
  @ApiPropertyOptional({
    description:
      'A `PROFESSION` code. Need not be one of the listing’s own three. Absent on a legacy write, ' +
      'where it is backfilled from the listing’s primary category.',
  })
  @IsString()
  @IsOptional()
  categoryCode?: string;

  @ApiPropertyOptional({ description: 'Required when the category has active children.' })
  @IsString()
  @IsOptional()
  subcategoryCode?: string;

  @ApiPropertyOptional({ description: 'Pence, greater than zero. Rendered as “Starts from £250”.' })
  @IsInt()
  @Min(1, { message: 'A price has to be more than nothing.' })
  @IsOptional()
  pricePence?: number;

  @ApiPropertyOptional({
    deprecated: true,
    description: 'The older name for `pricePence`, read when that is absent.',
  })
  @IsInt()
  @Min(0)
  @IsOptional()
  price?: number;

  @ApiPropertyOptional({
    enum: PriceBasis,
    deprecated: true,
    description: 'Not used for services (§5.2). Accepted so an older client is not refused.',
  })
  @IsEnum(PriceBasis)
  @IsOptional()
  priceBasis?: PriceBasis;

  @ApiPropertyOptional({
    deprecated: true,
    description: 'The older visibility lever. `false` creates it hidden.',
  })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiPropertyOptional({ type: [ServiceMediaKeyDto] })
  @IsArray()
  @ArrayMaxSize(SERVICE_LIMITS.media)
  @ValidateNested({ each: true })
  @Type(() => ServiceMediaKeyDto)
  @IsOptional()
  mediaKeys?: ServiceMediaKeyDto[];

  @ApiPropertyOptional({ type: [ServiceUpdateDto] })
  @IsArray()
  @ArrayMaxSize(SERVICE_LIMITS.updates)
  @ValidateNested({ each: true })
  @Type(() => ServiceUpdateDto)
  @IsOptional()
  updates?: ServiceUpdateDto[];

  @ApiPropertyOptional({ type: [ServiceMilestoneDto] })
  @IsArray()
  @ArrayMaxSize(SERVICE_LIMITS.milestones)
  @ValidateNested({ each: true })
  @Type(() => ServiceMilestoneDto)
  @IsOptional()
  milestones?: ServiceMilestoneDto[];
}

/**
 * The same body, every field optional — and **absent is not empty** (§5.5).
 *
 * A `PATCH` carrying only `{ name }` changes only the name. `mediaKeys: []` removes the media;
 * omitting it leaves the media alone. A client editing a title must not be able to wipe somebody's
 * photographs by omission, and must not be forced to re-send every array to avoid it.
 */
export class UpdateServiceDto {
  @ApiPropertyOptional({ maxLength: SERVICE_LIMITS.nameMax })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(SERVICE_LIMITS.nameMax)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ minLength: SERVICE_LIMITS.descriptionMin })
  @Trim()
  @IsString()
  @MaxLength(SERVICE_LIMITS.descriptionMax)
  @IsOptional()
  description?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  categoryCode?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  subcategoryCode?: string;

  @ApiPropertyOptional()
  @IsInt()
  @Min(1)
  @IsOptional()
  pricePence?: number;

  @ApiPropertyOptional({ deprecated: true, description: 'The older name for `pricePence`.' })
  @IsInt()
  @Min(0)
  @IsOptional()
  price?: number;

  @ApiPropertyOptional({
    enum: PriceBasis,
    deprecated: true,
    description: 'Not used for services (§5.2). Accepted so an older client is not refused.',
  })
  @IsEnum(PriceBasis)
  @IsOptional()
  priceBasis?: PriceBasis;

  @ApiPropertyOptional({ type: [ServiceMediaKeyDto] })
  @IsArray()
  @ArrayMaxSize(SERVICE_LIMITS.media)
  @ValidateNested({ each: true })
  @Type(() => ServiceMediaKeyDto)
  @IsOptional()
  mediaKeys?: ServiceMediaKeyDto[];

  @ApiPropertyOptional({ type: [ServiceUpdateDto] })
  @IsArray()
  @ArrayMaxSize(SERVICE_LIMITS.updates)
  @ValidateNested({ each: true })
  @Type(() => ServiceUpdateDto)
  @IsOptional()
  updates?: ServiceUpdateDto[];

  @ApiPropertyOptional({ type: [ServiceMilestoneDto] })
  @IsArray()
  @ArrayMaxSize(SERVICE_LIMITS.milestones)
  @ValidateNested({ each: true })
  @Type(() => ServiceMilestoneDto)
  @IsOptional()
  milestones?: ServiceMilestoneDto[];

  /**
   * Still read, never written by this client (§5.5.1).
   *
   * It meant the same thing as "not hidden", which is two fields for one fact. `status` is the
   * only answer now; an older build's `isActive: false` is taken as "hide it".
   */
  @ApiPropertyOptional({ deprecated: true, description: 'Deprecated. Use the visibility route.' })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

/** §5.5.1: showing and hiding, which must not be able to override a verification. */
export class ServiceVisibilityDto {
  @ApiProperty()
  @IsBoolean()
  isVisible: boolean;
}

/** §6.2's paged service list, and the filters §6.1 applies to both groups. */
export class ListServicesDto extends PageOptionsDto {
  @ApiPropertyOptional({
    description: 'Matches a service’s name and description. Under 2 characters is ignored.',
  })
  @Trim()
  @IsString()
  @IsOptional()
  q?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  category?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  subcategory?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  cityId?: string;

  @ApiPropertyOptional({ description: 'Pence.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  maxPricePence?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  @IsOptional()
  minRating?: number;

  @ApiPropertyOptional({
    description: 'Only services in a category the professional is verified for.',
  })
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  @IsOptional()
  verifiedOnly?: boolean;

  @ApiPropertyOptional({
    description:
      'Which result sets to answer with: `SERVICE`, `PROFESSIONAL`, or both. Only read by the ' +
      'blended search; both when absent.',
    example: 'SERVICE,PROFESSIONAL',
  })
  @IsString()
  @IsOptional()
  groups?: string;

  @ApiPropertyOptional({
    enum: PROFESSIONAL_SORTS,
    description:
      'The section’s existing vocabulary (§6.1). `RECOMMENDED` is relevance, and the default.',
  })
  @IsIn([...PROFESSIONAL_SORTS])
  @IsOptional()
  sort?: ProfessionalSort;
}
