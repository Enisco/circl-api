import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PostVisibility } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PageOptionsDto } from '@/common';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
const Bool = () => Transform(({ value }) => value === true || value === 'true');

export class CreateUpdateDto {
  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @Trim()
  @IsString()
  @MinLength(1, { message: 'content must not be empty' })
  @MaxLength(2000, { message: 'content must be 2000 characters or fewer' })
  content: string;

  @ApiPropertyOptional({ description: "Defaults to the author's city." })
  @Trim()
  @IsString()
  @IsOptional()
  cityId?: string;

  @ApiPropertyOptional({
    enum: [PostVisibility.PUBLIC, PostVisibility.ANONYMOUS],
    default: PostVisibility.PUBLIC,
    description: 'PRIVATE_TO_CIRCL is not valid for an Update.',
  })
  @IsIn([PostVisibility.PUBLIC, PostVisibility.ANONYMOUS])
  @IsOptional()
  visibility?: PostVisibility;

  @ApiPropertyOptional({ default: true, description: 'The composer\'s "Allow comments".' })
  @Bool()
  @IsBoolean()
  @IsOptional()
  commentsEnabled?: boolean;

  @ApiPropertyOptional({
    default: false,
    description: 'The composer exposes the inverse of this, "Unhide like count".',
  })
  @Bool()
  @IsBoolean()
  @IsOptional()
  reactionCountHidden?: boolean;

  @ApiPropertyOptional({ type: [String], description: '5 images or 1 video.' })
  @IsArray()
  @ArrayMaxSize(5)
  @IsOptional()
  mediaIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'From "Tag people". Tagged users are notified.',
  })
  @IsArray()
  @ArrayMaxSize(20)
  @IsOptional()
  taggedUserIds?: string[];

  @ApiPropertyOptional({
    description:
      'From "Add location". Free text is not accepted; it resolves to a city or a named place.',
  })
  @Trim()
  @IsString()
  @IsOptional()
  placeId?: string;
}

export class ListUpdatesDto extends PageOptionsDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  cityId?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  authorId?: string;
}

export class CreateUpdateReplyDto {
  @ApiProperty({ minLength: 1, maxLength: 1000 })
  @Trim()
  @IsString()
  @MinLength(1, { message: 'content must not be empty' })
  @MaxLength(1000, { message: 'content must be 1000 characters or fewer' })
  content: string;
}
