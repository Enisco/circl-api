import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AnnouncementChannel, AnnouncementState } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AdminPageOptionsDto, CsvArray, StrictBoolean } from '@/common';
import { AnalyticsFilterDto } from './analytics-filter.dto';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/** §5.18's section flags: members who have set up that side of the product. */
export const AUDIENCE_SECTIONS = ['PROFESSIONAL', 'CONNECT', 'STORE'] as const;
export type AudienceSection = (typeof AUDIENCE_SECTIONS)[number];

/** A push body is truncated by the OS, so the ceiling depends on the channels chosen. */
export const PUSH_BODY_MAX = 500;
export const BODY_MAX = 5000;

/**
 * §5.18: fewer than ten recipients is refused, for the same reason §2.7 suppresses a count.
 *
 * Its own name rather than an import of `POPULATION_FLOOR`, and that is deliberate: the analytics
 * floor exists so a **number** cannot identify a small group, and this one exists so an
 * announcement is not a message. They are the same ten today and they answer different questions,
 * so tying them together would mean raising the suppression threshold silently changed who can be
 * announced to.
 */
export const AUDIENCE_FLOOR = 10;

/**
 * Who an announcement goes to.
 *
 * The member filters only — the same vocabulary the member list and every chart use, so "members
 * in Leeds aged 25–34" means one thing across the portal. `from`/`to` are the **sign-up** date
 * here, as they are on the member list.
 *
 * `everyone: true` is required to send with no filter at all, rather than an empty filter meaning
 * everybody by default. Sending to the whole platform should be something somebody typed.
 */
export class AnnouncementAudienceDto {
  @ApiProperty({
    description:
      'Required to send with no filter. An empty filter does **not** mean everybody: addressing ' +
      'the whole platform is a decision, not a default.',
  })
  @StrictBoolean()
  everyone: boolean;

  @ApiPropertyOptional({
    type: AnalyticsFilterDto,
    description:
      'The member filters, and only those: `cityIds`, `gender`, `ageBands`, ' +
      '`countriesOfOrigin`, `heritage`, `journeyStages`, `interests`, `languages`, `platforms`, ' +
      '`appVersions`, `signupMethods`, `onboarding`, and `from`/`to` as the sign-up date. ' +
      'Anything else is a 400.',
  })
  @ValidateNested()
  @Type(() => AnalyticsFilterDto)
  @IsObject()
  @IsOptional()
  filter?: AnalyticsFilterDto;

  @ApiPropertyOptional({
    enum: AUDIENCE_SECTIONS,
    isArray: true,
    description:
      'Members who have that side of the product set up — a listing, a Connect profile, a shop. ' +
      'Several match **any**, not all.',
  })
  @IsArray()
  @IsIn([...AUDIENCE_SECTIONS], { each: true })
  @ArrayMaxSize(3)
  @IsOptional()
  sections?: AudienceSection[];
}

export class AnnouncementInputDto {
  @ApiProperty({ maxLength: 80 })
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(80)
  title: string;

  @ApiProperty({
    description:
      '≤ 500 characters when `PUSH` is one of the channels, ≤ 5000 otherwise — a push is cut off ' +
      'by the OS, and a body nobody can read in the only place it appears is not a message.',
  })
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(BODY_MAX)
  body: string;

  @ApiPropertyOptional({
    description:
      'Where tapping it goes, from `admin/meta/app-routes`. An allowlisted pattern, never an ' +
      'arbitrary URL.',
  })
  @Trim()
  @IsString()
  @MaxLength(200)
  @IsOptional()
  route?: string;

  @ApiProperty({ enum: AnnouncementChannel, isArray: true, description: 'At least one.' })
  @IsArray()
  @IsEnum(AnnouncementChannel, { each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  channels: AnnouncementChannel[];

  @ApiProperty({ type: AnnouncementAudienceDto })
  @ValidateNested()
  @Type(() => AnnouncementAudienceDto)
  @IsObject()
  audience: AnnouncementAudienceDto;
}

/** Every field optional, for a draft somebody is still writing. */
export class UpdateAnnouncementDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(80)
  @IsOptional()
  title?: string;

  @ApiPropertyOptional()
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(BODY_MAX)
  @IsOptional()
  body?: string;

  @ApiPropertyOptional({ nullable: true })
  @Transform(({ value }) => (value === '' || value === null ? null : value))
  @IsString()
  @MaxLength(200)
  @IsOptional()
  route?: string | null;

  @ApiPropertyOptional({ enum: AnnouncementChannel, isArray: true })
  @IsArray()
  @IsEnum(AnnouncementChannel, { each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @IsOptional()
  channels?: AnnouncementChannel[];

  @ApiPropertyOptional({ type: AnnouncementAudienceDto })
  @ValidateNested()
  @Type(() => AnnouncementAudienceDto)
  @IsObject()
  @IsOptional()
  audience?: AnnouncementAudienceDto;
}

export class ListAnnouncementsDto extends AdminPageOptionsDto {
  @ApiPropertyOptional({ enum: AnnouncementState, isArray: true, description: 'CSV.' })
  @CsvArray()
  @IsArray()
  @IsEnum(AnnouncementState, { each: true })
  @ArrayMaxSize(6)
  @IsOptional()
  state?: AnnouncementState[];

  @ApiPropertyOptional({ description: 'Created on or after this instant.' })
  @IsDateString()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({ description: 'Created on or before this instant.' })
  @IsDateString()
  @IsOptional()
  to?: string;
}

export class AudiencePreviewDto {
  @ApiProperty({ type: AnnouncementAudienceDto })
  @ValidateNested()
  @Type(() => AnnouncementAudienceDto)
  @IsObject()
  audience: AnnouncementAudienceDto;

  @ApiProperty({ enum: AnnouncementChannel, isArray: true })
  @IsArray()
  @IsEnum(AnnouncementChannel, { each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  channels: AnnouncementChannel[];
}

export class SendAnnouncementDto {
  @ApiProperty({
    description:
      'The audience size the sender was shown. Checked against a fresh count and refused with ' +
      '409 `STALE_AUDIENCE` if it has moved by more than 5% — somebody who pressed send after ' +
      'reading "1,200 people" should not reach 12,000 because a filter changed meaning in the ' +
      'meantime.',
  })
  @IsInt()
  @Min(0)
  confirmAudienceCount: number;
}

export class ScheduleAnnouncementDto {
  @ApiProperty({
    description:
      'At least five minutes out and at most ninety days. The floor is there so a schedule can ' +
      'still be cancelled after it is set.',
  })
  @IsDateString()
  scheduledAt: string;
}
