import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { JoinPolicy } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PageOptionsDto } from '@/common';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class CreateGroupDto {
  @ApiProperty({ minLength: 3, maxLength: 60 })
  @Trim()
  @IsString()
  @MinLength(3, { message: 'name must be at least 3 characters' })
  @MaxLength(60, { message: 'name must be 60 characters or fewer' })
  name: string;

  @ApiProperty({ minLength: 15, maxLength: 500 })
  @Trim()
  @IsString()
  @MinLength(15, { message: 'description must be at least 15 characters' })
  @MaxLength(500, { message: 'description must be 500 characters or fewer' })
  description: string;

  @ApiProperty()
  @Trim()
  @IsString()
  cityId: string;

  @ApiPropertyOptional({ enum: JoinPolicy, default: JoinPolicy.OPEN })
  @IsEnum(JoinPolicy)
  @IsOptional()
  joinPolicy?: JoinPolicy;

  @ApiPropertyOptional({ maxLength: 2000 })
  @Trim()
  @IsString()
  @MaxLength(2000)
  @IsOptional()
  rules?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  avatarMediaId?: string;
}

export class UpdateGroupDto {
  @ApiPropertyOptional({ minLength: 3, maxLength: 60 })
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(60)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ minLength: 15, maxLength: 500 })
  @Trim()
  @IsString()
  @MinLength(15)
  @MaxLength(500)
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ enum: JoinPolicy })
  @IsEnum(JoinPolicy)
  @IsOptional()
  joinPolicy?: JoinPolicy;

  @ApiPropertyOptional({ maxLength: 2000 })
  @Trim()
  @IsString()
  @MaxLength(2000)
  @IsOptional()
  rules?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  avatarMediaId?: string;
}

export class ListGroupsDto extends PageOptionsDto {
  @ApiPropertyOptional({
    description: 'Omit for "All cities", which the list screen offers explicitly.',
  })
  @IsString()
  @IsOptional()
  cityId?: string;

  @ApiPropertyOptional({
    enum: ['JOINED', 'PENDING', 'NOT_JOINED', 'ALL'],
    default: 'ALL',
    description: 'JOINED backs the My groups strip and the "Joined" filter pill.',
  })
  @IsIn(['JOINED', 'PENDING', 'NOT_JOINED', 'ALL'])
  @IsOptional()
  membership?: 'JOINED' | 'PENDING' | 'NOT_JOINED' | 'ALL';

  @ApiPropertyOptional({ description: 'Name and description.' })
  @Trim()
  @IsString()
  @IsOptional()
  q?: string;

  @ApiPropertyOptional({
    enum: ['RECOMMENDED', 'NEWEST', 'MOST_MEMBERS', 'MOST_ACTIVE'],
    default: 'RECOMMENDED',
  })
  @IsIn(['RECOMMENDED', 'NEWEST', 'MOST_MEMBERS', 'MOST_ACTIVE'])
  @IsOptional()
  sort?: 'RECOMMENDED' | 'NEWEST' | 'MOST_MEMBERS' | 'MOST_ACTIVE';
}

export class CreateGroupPostDto {
  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  content: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @ArrayMaxSize(5)
  @IsOptional()
  mediaIds?: string[];
}

export class CreateGroupPostReplyDto {
  @ApiProperty({ minLength: 1, maxLength: 1000 })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  content: string;
}

export class JoinDecisionDto {
  @ApiProperty({ enum: ['APPROVE', 'REJECT'] })
  @IsIn(['APPROVE', 'REJECT'])
  decision: 'APPROVE' | 'REJECT';
}
