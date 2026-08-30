import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PageOptionsDto } from '@/common';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class CreateGuideDto {
  @ApiProperty({ example: 'FINANCE' })
  @Trim()
  @IsString()
  topicCode: string;

  @ApiProperty({ minLength: 6, maxLength: 140 })
  @Trim()
  @IsString()
  @MinLength(6, { message: 'title must be at least 6 characters' })
  @MaxLength(140, { message: 'title must be 140 characters or fewer' })
  title: string;

  @ApiProperty({ minLength: 20, maxLength: 1000 })
  @Trim()
  @IsString()
  @MinLength(20, { message: 'intro must be at least 20 characters' })
  @MaxLength(1000, { message: 'intro must be 1000 characters or fewer' })
  intro: string;

  @ApiProperty({
    type: [String],
    description:
      '1 to 30 entries, each 1 to 2000 characters. Until the composer splits its body, the client ' +
      'sends the whole body as a single-element array, which is accepted (1.6.3).',
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'steps must have at least one entry' })
  @ArrayMaxSize(30, { message: 'steps must have 30 entries or fewer' })
  @IsString({ each: true })
  @MaxLength(2000, { each: true, message: 'each step must be 2000 characters or fewer' })
  steps: string[];

  @ApiPropertyOptional()
  @Trim()
  @IsString()
  @IsOptional()
  cityId?: string;

  @ApiPropertyOptional({ description: 'Must be http(s).' })
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true },
    { message: 'resourceUrl must be a valid http(s) URL' },
  )
  @IsOptional()
  resourceUrl?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @ArrayMaxSize(5)
  @IsOptional()
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  mediaKeys?: string[];
}

export class ListGuidesDto extends PageOptionsDto {
  @ApiPropertyOptional({ description: 'A GuideTopic code. "All" simply omits the param.' })
  @Trim()
  @IsString()
  @IsOptional()
  topic?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  cityId?: string;

  @ApiPropertyOptional({ description: 'Title and intro.' })
  @Trim()
  @IsString()
  @IsOptional()
  q?: string;

  @ApiPropertyOptional({ enum: ['RECENT', 'MOST_READ', 'MOST_LIKED'], default: 'RECENT' })
  @IsIn(['RECENT', 'MOST_READ', 'MOST_LIKED'])
  @IsOptional()
  sort?: 'RECENT' | 'MOST_READ' | 'MOST_LIKED';

  @ApiPropertyOptional({
    enum: ['MOST_READ_THIS_WEEK', 'CONTINUE_READING', 'ALL'],
    default: 'ALL',
    description:
      'Convenience for the three strips on the Guides tab. CONTINUE_READING returns only guides ' +
      'this user started and did not finish, and may be empty — the client hides the strip.',
  })
  @IsIn(['MOST_READ_THIS_WEEK', 'CONTINUE_READING', 'ALL'])
  @IsOptional()
  section?: 'MOST_READ_THIS_WEEK' | 'CONTINUE_READING' | 'ALL';

  @ApiPropertyOptional({
    description:
      'Only guides this member has saved, for the Bookmarks row in the profile hub. Paged and ' +
      'sorted like any other guide list.',
  })
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  @IsOptional()
  bookmarked?: boolean;
}

export class GuideProgressDto {
  @ApiProperty({
    minimum: 0,
    maximum: 1,
    description: 'A float 0..1. Client throttles to once per 5s.',
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  progress: number;
}

export class GuideFeedbackDto {
  @ApiProperty({ description: 'The "Was this useful?" Yes / No pair at the end of the guide.' })
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  useful: boolean;

  @ApiPropertyOptional({ maxLength: 1000 })
  @Trim()
  @IsString()
  @MaxLength(1000)
  @IsOptional()
  note?: string;
}

export class GuideMatchDto {
  @ApiProperty()
  @Trim()
  @IsString()
  categoryCode: string;

  @ApiProperty({ description: 'The draft title, the strongest signal available.' })
  @Trim()
  @IsString()
  @MaxLength(200)
  title: string;

  @ApiPropertyOptional({ maxLength: 4000 })
  @Trim()
  @IsString()
  @MaxLength(4000)
  @IsOptional()
  description?: string;

  @ApiPropertyOptional()
  @Trim()
  @IsString()
  @IsOptional()
  cityId?: string;
}

export class GuideDeflectionDto {
  @ApiProperty({ enum: ['ANSWERED', 'POSTED_ANYWAY'] })
  @IsIn(['ANSWERED', 'POSTED_ANYWAY'])
  outcome: 'ANSWERED' | 'POSTED_ANYWAY';
}
