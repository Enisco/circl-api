import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
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

export class CreateResponseDto {
  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @Trim()
  @IsString()
  @MinLength(1, { message: 'content must not be empty' })
  @MaxLength(2000, { message: 'content must be 2000 characters or fewer' })
  content: string;

  @ApiPropertyOptional({
    default: false,
    description: 'The "I can help" mode. Only one per person per request (1.3.2).',
  })
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  @IsOptional()
  isHelpOffer?: boolean;

  @ApiPropertyOptional({
    default: false,
    description: 'Private responses are returned only to the request owner and their author.',
  })
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  @IsOptional()
  isPrivate?: boolean;

  @ApiPropertyOptional({ description: 'Only meaningful when isHelpOffer.' })
  @IsDateString()
  @IsOptional()
  availableOn?: string;

  @ApiPropertyOptional({
    description:
      'Pence. Only when isHelpOffer. Circl does not handle this money — it is a number the two ' +
      'parties agree between themselves (D4).',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000)
  @IsOptional()
  thankYouExpected?: number;
}

export class ListResponsesDto extends PageOptionsDto {
  @ApiPropertyOptional({
    enum: ['OLDEST', 'NEWEST'],
    default: 'OLDEST',
    description: 'Threads read chronologically, so OLDEST is the default.',
  })
  @IsIn(['OLDEST', 'NEWEST'])
  @IsOptional()
  sort?: 'OLDEST' | 'NEWEST';
}
