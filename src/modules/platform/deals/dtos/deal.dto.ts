import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DealStage, DealTiming, DealTrack } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { ToBoolean } from '@/common';

export class ProposeDealDto {
  @ApiProperty({ description: 'Pence, as everywhere else on the way in.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount: number;

  @ApiPropertyOptional({ default: 'GBP' })
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a three-letter code.' })
  @IsOptional()
  currency?: string;

  @ApiProperty({
    enum: DealTiming,
    description: 'UPFRONT puts the payment pair before fulfilment, ON_COMPLETION after it.',
  })
  @IsEnum(DealTiming)
  timing: DealTiming;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Pence, and strictly less than `amount`: a deposit equal to the total leaves no balance and ' +
      'a payment step with nothing to pay. A deposit also forces the balance to the end.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  deposit?: number | null;

  @ApiPropertyOptional({ default: false })
  @ToBoolean()
  @IsBoolean()
  @IsOptional()
  collects?: boolean;

  @ApiPropertyOptional({ maxLength: 280 })
  @IsString()
  @MaxLength(280)
  @IsOptional()
  summary?: string;
}

export class MarkStepsDto {
  @ApiProperty({
    enum: DealStage,
    isArray: true,
    description:
      'One or more stages, applied in spine order and atomically: a buyer collecting and paying ' +
      'at the counter should not tap three times while the seller waits, and if any one stage is ' +
      'invalid none is applied.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(11)
  @IsEnum(DealStage, { each: true })
  stages: DealStage[];

  @ApiPropertyOptional({ description: 'Pence. Accompanies PAID or DEPOSIT_PAID.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  amount?: number;

  @ApiPropertyOptional({ default: 'GBP' })
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a three-letter code.' })
  @IsOptional()
  currency?: string;
}

export class CorrectAmountDto {
  @ApiProperty({ description: 'Pence.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  amount: number;

  @ApiPropertyOptional({ default: 'GBP' })
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a three-letter code.' })
  @IsOptional()
  currency?: string;

  @ApiPropertyOptional({
    enum: [DealStage.PAID, DealStage.DEPOSIT_PAID],
    description: 'Which figure to correct. Defaults to the payment, then the deposit.',
  })
  @IsIn([DealStage.PAID, DealStage.DEPOSIT_PAID])
  @IsOptional()
  stage?: DealStage;
}

export class FlagProblemDto {
  @ApiPropertyOptional({ maxLength: 1000 })
  @IsString()
  @MaxLength(1000)
  @IsOptional()
  note?: string;
}

export class DealTrackQueryDto {
  @ApiProperty({
    enum: DealTrack,
    description:
      'Required: the two tracks are two screens and summing them would be one number nobody asked for.',
  })
  @IsEnum(DealTrack)
  track: DealTrack;
}
