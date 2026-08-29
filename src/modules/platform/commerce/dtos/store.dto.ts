import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Fulfilment, StoreStatus, Weekday } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
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

export class OpeningHoursDto {
  @ApiProperty({ enum: Weekday })
  @IsEnum(Weekday)
  day: Weekday;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1439,
    description: 'Minutes from midnight. Null with closeMinutes null means closed all day.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1439)
  @IsOptional()
  openMinutes?: number | null;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1439,
    description:
      'closeMinutes <= openMinutes means it closes the next day: 6pm to 2am is { open: 1080, close: 120 }.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1439)
  @IsOptional()
  closeMinutes?: number | null;
}

export class StoreContactDto {
  @ApiProperty({ description: 'PHONE, WHATSAPP, INSTAGRAM, TIKTOK or WEBSITE.' })
  @Trim()
  @IsString()
  channel: string;

  @ApiProperty()
  @Trim()
  @IsString()
  @MaxLength(200)
  value: string;
}

export class CreateStoreDto {
  @ApiProperty({ minLength: 2, maxLength: 60 })
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name: string;

  @ApiPropertyOptional({ default: 'LOCAL', description: 'LOCAL or GENERAL.' })
  @Trim()
  @IsString()
  @IsOptional()
  type?: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @Trim()
  @IsString()
  @MaxLength(1000)
  @IsOptional()
  description?: string;

  @ApiProperty({
    minLength: 2,
    maxLength: 80,
    description: 'The area within the city, e.g. "Moss Side".',
  })
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  area: string;

  @ApiPropertyOptional({ description: 'Prefilled from the profile.' })
  @Trim()
  @IsString()
  @IsOptional()
  cityId?: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'A real safety need for home-run businesses. When true, only the area and an approximate ' +
      'coordinate are ever returned — line1, postcode and the precise point are never sent to ' +
      'anyone, including through the map.',
  })
  @Bool()
  @IsBoolean()
  @IsOptional()
  hidesExactAddress?: boolean;

  @ApiPropertyOptional()
  @Trim()
  @IsString()
  @MaxLength(200)
  @IsOptional()
  addressLine1?: string;

  @ApiPropertyOptional()
  @Trim()
  @IsString()
  @MaxLength(20)
  @IsOptional()
  postcode?: string;

  @ApiPropertyOptional()
  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  latitude?: number;

  @ApiPropertyOptional()
  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  longitude?: number;

  @ApiPropertyOptional({
    type: [String],
    description: "Max 4. Suggested from the seller's own heritage.",
  })
  @IsArray()
  @ArrayMaxSize(4)
  @IsString({ each: true })
  @IsOptional()
  heritageTags?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'Item category codes. Derivable from items, so a hint.',
  })
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @IsOptional()
  categories?: string[];

  @ApiPropertyOptional({
    type: [StoreContactDto],
    description: 'PHONE prefilled from the profile.',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StoreContactDto)
  @IsOptional()
  contact?: StoreContactDto[];

  @ApiPropertyOptional({ type: [OpeningHoursDto], description: 'Exactly 7 entries when sent.' })
  @IsArray()
  @ArrayMinSize(7)
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => OpeningHoursDto)
  @IsOptional()
  openingHours?: OpeningHoursDto[];

  @ApiPropertyOptional({ default: false })
  @Bool()
  @IsBoolean()
  @IsOptional()
  delivers?: boolean;

  @ApiPropertyOptional({ description: 'Suggested from the avatar.' })
  @IsString()
  @IsOptional()
  logoKey?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  coverKey?: string;
}

export class UpdateStoreDto extends CreateStoreDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 60 })
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  @IsOptional()
  declare name: string;

  @ApiPropertyOptional({ minLength: 2, maxLength: 80 })
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  @IsOptional()
  declare area: string;
}

export class StoreStatusDto {
  @ApiProperty({
    enum: StoreStatus,
    description:
      'Overrides opening hours. A store on holiday is not open even at 10am on a Tuesday.',
  })
  @IsEnum(StoreStatus)
  status: StoreStatus;
}

export class ItemDto {
  @ApiProperty({ minLength: 2, maxLength: 100 })
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @ApiProperty({ description: 'Pence, greater than zero.' })
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: 'price must be greater than zero' })
  price: number;

  @ApiPropertyOptional({ default: 'EACH' })
  @Trim()
  @IsString()
  @IsOptional()
  unitCode?: string;

  @ApiPropertyOptional({
    description: 'For the genuine exceptions the code list does not cover (D21).',
  })
  @Trim()
  @IsString()
  @MaxLength(40)
  @IsOptional()
  unitCustomLabel?: string;

  @ApiProperty()
  @Trim()
  @IsString()
  categoryCode: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @Trim()
  @IsString()
  @MaxLength(1000)
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ default: true })
  @Bool()
  @IsBoolean()
  @IsOptional()
  isAvailable?: boolean;

  @ApiPropertyOptional({ type: [String], description: 'Max 5. The first is the cover.' })
  @IsArray()
  @ArrayMaxSize(5)
  @IsOptional()
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  photoKeys?: string[];

  @ApiPropertyOptional({ description: 'Size or weight variants, free text for now.' })
  @Trim()
  @IsString()
  @MaxLength(200)
  @IsOptional()
  options?: string;

  @ApiPropertyOptional({ description: 'From an accepted AI draft, for measurement only.' })
  @IsString()
  @IsOptional()
  sourceDraftId?: string;
}

export class UpdateItemDto extends ItemDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 100 })
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @IsOptional()
  declare name: string;

  @ApiPropertyOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  declare price: number;

  @ApiPropertyOptional()
  @Trim()
  @IsString()
  @IsOptional()
  declare categoryCode: string;
}

/** Every filter applies to both stores and items; only the results differ (4.4.1). */
export class BrowseCommerceDto extends PageOptionsDto {
  @ApiPropertyOptional({ type: [String] })
  @CsvArray()
  @IsArray()
  @IsOptional()
  categories?: string[];

  @ApiPropertyOptional({ type: [String] })
  @CsvArray()
  @IsArray()
  @IsOptional()
  heritage?: string[];

  @ApiPropertyOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @IsOptional()
  maxDistanceMiles?: number;

  @ApiPropertyOptional()
  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  latitude?: number;

  @ApiPropertyOptional()
  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  longitude?: number;

  @ApiPropertyOptional()
  @Bool()
  @IsBoolean()
  @IsOptional()
  openNow?: boolean;

  @ApiPropertyOptional({
    description:
      'A store passes if ANYTHING it sells falls in the band — filtering by an average empties the ' +
      'tab for a shop selling both a 50p sachet and a £20 bag of rice.',
  })
  @Trim()
  @IsString()
  @IsOptional()
  priceBand?: string;

  @ApiPropertyOptional()
  @Bool()
  @IsBoolean()
  @IsOptional()
  delivers?: boolean;

  @ApiPropertyOptional()
  @Trim()
  @IsString()
  @IsOptional()
  q?: string;

  @ApiPropertyOptional({ description: 'LOCAL or GENERAL.' })
  @Trim()
  @IsString()
  @IsOptional()
  type?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  cityId?: string;

  @ApiPropertyOptional({
    enum: ['RECOMMENDED', 'NEAREST', 'RATING', 'NEWEST', 'PRICE_LOW', 'PRICE_HIGH'],
    default: 'RECOMMENDED',
  })
  @IsIn(['RECOMMENDED', 'NEAREST', 'RATING', 'NEWEST', 'PRICE_LOW', 'PRICE_HIGH'])
  @IsOptional()
  sort?: 'RECOMMENDED' | 'NEAREST' | 'RATING' | 'NEWEST' | 'PRICE_LOW' | 'PRICE_HIGH';
}

export class ListStoreItemsDto extends PageOptionsDto {
  @ApiPropertyOptional()
  @Trim()
  @IsString()
  @IsOptional()
  category?: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'An out-of-stock item still tells a buyer what the shop sells, so this defaults off.',
  })
  @Bool()
  @IsBoolean()
  @IsOptional()
  availableOnly?: boolean;

  @ApiPropertyOptional()
  @Trim()
  @IsString()
  @IsOptional()
  q?: string;
}

export class CartLineDto {
  @ApiProperty()
  @Trim()
  @IsString()
  itemId: string;

  @ApiProperty({ minimum: 1, maximum: 99 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(99)
  quantity: number;
}

export class ValidateCartDto {
  @ApiProperty({ type: [CartLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CartLineDto)
  lines: CartLineDto[];
}

export class CreateEnquiryDto {
  @ApiProperty()
  @Trim()
  @IsString()
  storeId: string;

  @ApiProperty({ type: [CartLineDto], description: '1 to 50 lines.' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CartLineDto)
  lines: CartLineDto[];

  @ApiProperty({ enum: Fulfilment })
  @IsEnum(Fulfilment)
  fulfilment: Fulfilment;

  @ApiPropertyOptional({ minLength: 6, maxLength: 300, description: 'Required for DELIVERY.' })
  @Trim()
  @IsString()
  @MinLength(6)
  @MaxLength(300)
  @IsOptional()
  deliveryAddress?: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @Trim()
  @IsString()
  @MaxLength(1000)
  @IsOptional()
  note?: string;
}

export class ListEnquiriesDto extends PageOptionsDto {
  @ApiPropertyOptional({ enum: ['BUYER', 'SELLER'], default: 'BUYER' })
  @IsIn(['BUYER', 'SELLER'])
  @IsOptional()
  role?: 'BUYER' | 'SELLER';

  @ApiPropertyOptional({ type: [String] })
  @CsvArray()
  @IsArray()
  @IsOptional()
  state?: string[];
}

export class AiDraftItemsDto {
  @ApiProperty({ type: [String], description: '1 to 10 photos.' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsString({ each: true })
  mediaKeys: string[];

  @ApiPropertyOptional({
    enum: ['WARM', 'SHORT', 'FORMAL'],
    default: 'WARM',
    description: 'Regenerating with a different tone must not re-upload the photos.',
  })
  @IsIn(['WARM', 'SHORT', 'FORMAL'])
  @IsOptional()
  tone?: 'WARM' | 'SHORT' | 'FORMAL';

  @ApiPropertyOptional({
    description: "Lets the model match the store's existing categories and pricing.",
  })
  @Trim()
  @IsString()
  @IsOptional()
  storeId?: string;
}
