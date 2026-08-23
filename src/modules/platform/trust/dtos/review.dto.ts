import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReviewContext } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
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

export class CreateReviewDto {
  @ApiProperty({ description: 'Cannot be the caller.' })
  @Trim() @IsString()
  subjectUserId: string;

  @ApiProperty({ minimum: 1, maximum: 5 })
  @Type(() => Number) @IsInt() @Min(1) @Max(5)
  rating: number;

  @ApiProperty({ minLength: 20, maxLength: 2000, description: 'The composer blocks below 20 and counts down.' })
  @Trim()
  @IsString()
  @MinLength(20, { message: 'comment must be at least 20 characters' })
  @MaxLength(2000, { message: 'comment must be 2000 characters or fewer' })
  comment: string;

  @ApiProperty({ enum: ReviewContext })
  @IsEnum(ReviewContext)
  context: ReviewContext;

  @ApiPropertyOptional({
    description:
      'Required for BOOKING (the booking id), ORDER (the enquiry id) and COMMUNITY (the request ' +
      'id). Absent for PRIOR_WORK.',
  })
  @Trim() @IsString() @IsOptional()
  sourceId?: string;

  @ApiPropertyOptional({ type: [String], description: 'Max 5, from the taxonomy help-tag list.' })
  @IsArray() @ArrayMaxSize(5) @IsOptional()
  tags?: string[];
}

export class UpdateReviewDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @Type(() => Number) @IsInt() @Min(1) @Max(5) @IsOptional()
  rating?: number;

  @ApiPropertyOptional({ minLength: 20, maxLength: 2000 })
  @Trim() @IsString() @MinLength(20) @MaxLength(2000) @IsOptional()
  comment?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray() @ArrayMaxSize(5) @IsOptional()
  tags?: string[];
}

export class ReviewReplyDto {
  @ApiProperty({ minLength: 1, maxLength: 1000 })
  @Trim() @IsString() @MinLength(1) @MaxLength(1000)
  comment: string;
}

export class ListReviewsDto extends PageOptionsDto {
  @ApiPropertyOptional({ enum: [...Object.values(ReviewContext), 'ALL'], default: 'ALL' })
  @IsString() @IsOptional()
  context?: ReviewContext | 'ALL';

  @ApiPropertyOptional({ enum: ['RECENT', 'HIGHEST', 'LOWEST'], default: 'RECENT' })
  @IsIn(['RECENT', 'HIGHEST', 'LOWEST']) @IsOptional()
  sort?: 'RECENT' | 'HIGHEST' | 'LOWEST';
}
