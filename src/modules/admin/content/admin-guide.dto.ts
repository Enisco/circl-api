import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export const GUIDE_BLOCK_TYPES = ['HEADING', 'PARAGRAPH', 'STEP'] as const;

export class GuideBlockDto {
  @ApiProperty({ enum: GUIDE_BLOCK_TYPES })
  @IsIn([...GUIDE_BLOCK_TYPES])
  type: (typeof GUIDE_BLOCK_TYPES)[number];

  @ApiProperty({ maxLength: 2000 })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  text: string;
}

/** §5.8's `GuideInput`. */
export class GuideInputDto {
  @ApiProperty({ description: 'A GUIDE_TOPIC code.' })
  @Trim()
  @IsString()
  topicCode: string;

  @ApiProperty({ maxLength: 140 })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(140)
  title: string;

  @ApiProperty({ maxLength: 600 })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(600)
  intro: string;

  @ApiProperty({ type: [GuideBlockDto], maxItems: 60 })
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => GuideBlockDto)
  blocks: GuideBlockDto[];

  @ApiPropertyOptional({
    description:
      'An external reference. **https only**: a guide is published by Circl, and an http link in ' +
      'one is a downgrade attack with our name on it.',
  })
  @Trim()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @IsOptional()
  resourceUrl?: string;

  @ApiPropertyOptional({ description: 'Null for a guide that is not about one city.' })
  @IsString()
  @IsOptional()
  cityId?: string | null;
}

/**
 * A patch. Every field optional, and `blocks` replaces the whole list when sent.
 *
 * Declared rather than `PartialType(GuideInputDto)` so the validators are visible here: a patch
 * that silently dropped `@MaxLength` would let an edit write a title no create could.
 */
export class PatchGuideDto {
  @ApiPropertyOptional()
  @Trim()
  @IsString()
  @IsOptional()
  topicCode?: string;

  @ApiPropertyOptional({ maxLength: 140 })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(140)
  @IsOptional()
  title?: string;

  @ApiPropertyOptional({ maxLength: 600 })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(600)
  @IsOptional()
  intro?: string;

  @ApiPropertyOptional({ type: [GuideBlockDto], maxItems: 60 })
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => GuideBlockDto)
  @IsOptional()
  blocks?: GuideBlockDto[];

  @ApiPropertyOptional()
  @Trim()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @IsOptional()
  resourceUrl?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  cityId?: string | null;
}

/** §5.8's performance window. */
export class GuidePerformanceDto {
  @ApiPropertyOptional({ description: 'Defaults to thirty days ago.' })
  @IsISO8601()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({ description: 'Defaults to now.' })
  @IsISO8601()
  @IsOptional()
  to?: string;
}
