import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GroupVisibility, JoinPolicy } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PageOptionsDto } from '@/common';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/** A list, or the one blob of text an older build sends, which becomes a single rule. */
const Rules = () =>
  Transform(({ value }) =>
    typeof value === 'string' ? (value.trim() ? [value.trim()] : []) : value,
  );

/** Repeated or comma-separated, because both are sent and neither is wrong. */
const CsvArray = () =>
  Transform(({ value }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map(part => part.trim())
          .filter(Boolean)
      : value,
  );

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

  @ApiPropertyOptional({
    enum: GroupVisibility,
    default: GroupVisibility.OPEN,
    description:
      'Who can read it without getting in, which is a separate decision from `joinPolicy`. An ' +
      'OPEN group is a forum people read before they commit; a CLOSED one tells a non-member its ' +
      'name, description, city, category, member count and rules, and nothing it has said.',
  })
  @IsEnum(GroupVisibility)
  @IsOptional()
  visibility?: GroupVisibility;

  @ApiPropertyOptional({ description: 'A COMMUNITY_CATEGORY code, the list the feed filters by.' })
  @Trim()
  @IsString()
  @IsOptional()
  categoryCode?: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'One entry per rule. A plain string is still accepted and becomes a single rule — it is ' +
      'not split on newlines, because nobody agreed that a newline starts a rule.',
  })
  @Rules()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  @IsOptional()
  rules?: string[];

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  avatarKey?: string;
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

  @ApiPropertyOptional({
    enum: GroupVisibility,
    description:
      'Changeable at any time, and it changes nothing about who is a member: closing a group ' +
      'stops a non-member reading its wall, and the chat was always members only.',
  })
  @IsEnum(GroupVisibility)
  @IsOptional()
  visibility?: GroupVisibility;

  @ApiPropertyOptional()
  @Trim()
  @IsString()
  @IsOptional()
  cityId?: string;

  @ApiPropertyOptional({ description: 'A COMMUNITY_CATEGORY code.' })
  @Trim()
  @IsString()
  @IsOptional()
  categoryCode?: string;

  @ApiPropertyOptional({ type: [String], description: 'Replaces the list. Absent leaves it.' })
  @Rules()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  @IsOptional()
  rules?: string[];

  @ApiPropertyOptional({
    nullable: true,
    description: 'A key replaces, an explicit `null` removes it, absent leaves it alone.',
  })
  @IsString()
  @IsOptional()
  avatarKey?: string | null;
}

export class JoinGroupDto {
  @ApiPropertyOptional({
    maxLength: 500,
    description:
      'Shown to the admin beside the request. Optional, may be empty, and plain text — it is ' +
      'whatever the asker typed. Ignored by an open group, which has nobody to show it to.',
  })
  @Trim()
  @IsString()
  @MaxLength(500)
  @IsOptional()
  message?: string;
}

export class InviteMembersDto {
  @ApiProperty({ type: [String], description: 'Several at once. Already invited is not an error.' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  userIds: string[];
}

export class InviteAnswerDto {
  @ApiProperty()
  @IsBoolean()
  accept: boolean;
}

export class MuteGroupDto {
  @ApiProperty()
  @IsBoolean()
  isMuted: boolean;
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

  @ApiPropertyOptional({
    enum: ['MINE', 'DISCOVER'],
    description:
      'MINE is every group the caller is in, DISCOVER every other one. Absent means both. A ' +
      'closed group still appears in DISCOVER: its name and description are public.',
  })
  @IsIn(['MINE', 'DISCOVER'])
  @IsOptional()
  scope?: 'MINE' | 'DISCOVER';

  @ApiPropertyOptional({ type: [String], description: 'Repeated. COMMUNITY_CATEGORY codes.' })
  @CsvArray()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @IsOptional()
  categoryCodes?: string[];

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
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  mediaKeys?: string[];
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
  @ApiPropertyOptional({
    enum: ['APPROVE', 'REJECT'],
    description: 'Either this or `approve`. Both are accepted; this one wins where both are sent.',
  })
  @IsIn(['APPROVE', 'REJECT'])
  @IsOptional()
  decision?: 'APPROVE' | 'REJECT';

  @ApiPropertyOptional({ description: 'The same answer as a bool, which is what the app sends.' })
  @IsBoolean()
  @IsOptional()
  approve?: boolean;
}

/** A page with a name search on it, for the member, request and invite lists. */
export class SearchPageDto extends PageOptionsDto {
  @ApiPropertyOptional({ description: 'Searches names.' })
  @Trim()
  @IsString()
  @IsOptional()
  q?: string;
}
