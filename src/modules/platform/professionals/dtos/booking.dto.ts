import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BookingMode, BriefUrgency, DisputeReason, JobState } from '@prisma/client';
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

export class CreateBriefDto {
  @ApiProperty({ description: 'A managed category code.' })
  @Trim()
  @IsString()
  categoryCode: string;

  @ApiProperty({ minLength: 1, maxLength: 4000 })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  description: string;

  @ApiPropertyOptional({ enum: BriefUrgency, default: BriefUrgency.FLEXIBLE })
  @IsEnum(BriefUrgency)
  @IsOptional()
  urgency?: BriefUrgency;

  @ApiPropertyOptional({ description: 'Pence. Display only, as everywhere.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  budget?: number;

  @ApiPropertyOptional({ description: "Defaults to the member's city." })
  @Trim()
  @IsString()
  @IsOptional()
  cityId?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @ArrayMaxSize(5)
  @IsOptional()
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  mediaKeys?: string[];
}

export class ChooseMatchDto {
  @ApiProperty()
  @Trim()
  @IsString()
  listingId: string;
}

/** A booking is an agreement about work, not a transaction (2.0.1). */
export class CreateBookingDto {
  @ApiProperty()
  @Trim()
  @IsString()
  listingId: string;

  @ApiPropertyOptional({
    description:
      'Required unless briefId is given. The server copies name, description and price from it — ' +
      'do not send those values.',
  })
  @Trim()
  @IsString()
  @IsOptional()
  serviceId?: string;

  @ApiPropertyOptional({
    description:
      'Required unless serviceId is given. The server copies description, urgency and budget from ' +
      'it, so the brief is written once and survives all three steps (2.1.5).',
  })
  @Trim()
  @IsString()
  @IsOptional()
  briefId?: string;

  @ApiPropertyOptional()
  @IsDateString()
  @IsOptional()
  preferredDate?: string;

  @ApiPropertyOptional()
  @Trim()
  @IsString()
  @MaxLength(80)
  @IsOptional()
  preferredTimeSlot?: string;

  @ApiPropertyOptional({ default: false, description: 'When true, date and slot are ignored.' })
  @Bool()
  @IsBoolean()
  @IsOptional()
  isFlexible?: boolean;

  @ApiPropertyOptional({ enum: BookingMode, default: BookingMode.ONLINE })
  @IsEnum(BookingMode)
  @IsOptional()
  mode?: BookingMode;

  @ApiPropertyOptional({ description: 'Only for IN_PERSON.' })
  @Trim()
  @IsString()
  @MaxLength(300)
  @IsOptional()
  address?: string;

  @ApiPropertyOptional({
    maxLength: 2000,
    description: 'When briefId is present this is an addition, not a replacement.',
  })
  @Trim()
  @IsString()
  @MaxLength(2000)
  @IsOptional()
  details?: string;

  @ApiPropertyOptional({
    description: 'Pence. A record of what the two agreed. Circl does not process it (D12).',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  agreedAmount?: number;
}

export class ListBookingsDto extends PageOptionsDto {
  @ApiPropertyOptional({
    enum: ['CLIENT', 'PROFESSIONAL'],
    default: 'CLIENT',
    description: 'PROFESSIONAL is only valid for someone with a listing; 403 otherwise.',
  })
  @IsIn(['CLIENT', 'PROFESSIONAL'])
  @IsOptional()
  role?: 'CLIENT' | 'PROFESSIONAL';

  @ApiPropertyOptional({ isArray: true, enum: JobState, description: 'Comma list.' })
  @CsvArray()
  @IsArray()
  @IsOptional()
  state?: JobState[];
}

export class TransitionReasonDto {
  @ApiProperty({ minLength: 1, maxLength: 1000 })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  reason: string;
}

export class RequestChangesDto {
  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  message: string;
}

export class DeliverDto {
  @ApiPropertyOptional({ maxLength: 2000 })
  @Trim()
  @IsString()
  @MaxLength(2000)
  @IsOptional()
  note?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @ArrayMaxSize(5)
  @IsOptional()
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  mediaKeys?: string[];
}

export class CancelDto {
  @ApiPropertyOptional({ maxLength: 1000 })
  @Trim()
  @IsString()
  @MaxLength(1000)
  @IsOptional()
  reason?: string;
}

/** The canonical, polymorphic dispute payload (4.1.3). */
export class OpenDisputeDto {
  @ApiProperty({ enum: ['BOOKING', 'ORDER'] })
  @IsIn(['BOOKING', 'ORDER'])
  subjectType: 'BOOKING' | 'ORDER';

  @ApiProperty({ description: 'The booking id or the enquiry id, depending on subjectType.' })
  @Trim()
  @IsString()
  subjectId: string;

  @ApiProperty({ enum: DisputeReason })
  @IsEnum(DisputeReason)
  reasonCode: DisputeReason;

  @ApiProperty({ minLength: 20, maxLength: 4000, description: 'The composer blocks below 20.' })
  @Trim()
  @IsString()
  @MinLength(20)
  @MaxLength(4000)
  description: string;

  @ApiPropertyOptional({ type: [String], description: 'Evidence.' })
  @IsArray()
  @ArrayMaxSize(5)
  @IsOptional()
  mediaKeys?: string[];
}

export class CreateDisputeDto {
  @ApiProperty({ enum: DisputeReason })
  @IsEnum(DisputeReason)
  reasonCode: DisputeReason;

  @ApiProperty({ minLength: 20, maxLength: 4000, description: 'The composer blocks below 20.' })
  @Trim()
  @IsString()
  @MinLength(20)
  @MaxLength(4000)
  description: string;

  @ApiPropertyOptional({ type: [String], description: 'Evidence.' })
  @IsArray()
  @ArrayMaxSize(5)
  @IsOptional()
  mediaKeys?: string[];
}

export class DisputeEvidenceDto {
  @ApiPropertyOptional({ maxLength: 2000 })
  @Trim()
  @IsString()
  @MaxLength(2000)
  @IsOptional()
  note?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @ArrayMaxSize(5)
  @IsOptional()
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  mediaKeys?: string[];
}

export class ManagedRequestDto {
  @ApiProperty({ enum: ['STOREFRONT', 'PROFESSIONAL_PLACEMENT'] })
  @IsIn(['STOREFRONT', 'PROFESSIONAL_PLACEMENT'])
  subjectType: 'STOREFRONT' | 'PROFESSIONAL_PLACEMENT';

  @ApiPropertyOptional({ type: [String], description: 'For STOREFRONT, from storeHelpAreas.' })
  @IsArray()
  @ArrayMaxSize(6)
  @IsOptional()
  helpAreas?: string[];

  @ApiPropertyOptional({ description: 'For PROFESSIONAL_PLACEMENT.' })
  @Trim()
  @IsString()
  @IsOptional()
  briefId?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @Trim()
  @IsString()
  @MaxLength(2000)
  @IsOptional()
  notes?: string;

  @ApiPropertyOptional({ description: 'For STOREFRONT, when a store already exists.' })
  @Trim()
  @IsString()
  @IsOptional()
  storeId?: string;
}
