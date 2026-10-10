import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EnforcementSourceType, Gender, ReportTargetType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { CsvArray, ReasonedDto } from '@/common';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/** The same bounds as member self-edit (§5.5 "Field bounds"), so one account cannot hold a value the other path refuses. */
export const USERNAME_PATTERN = /^[a-z0-9_.]{3,30}$/;

export const SUSPENSION_DURATIONS = ['24h', '7d', '30d', 'permanent', 'custom'] as const;
export type SuspensionDuration = (typeof SUSPENSION_DURATIONS)[number];

/**
 * A staff correction to a member's profile (§5.5, S10.2).
 *
 * Every field is optional and every field is declared, because `forbidNonWhitelisted` turns an
 * undeclared field into a 400 naming it — which is the behaviour wanted here. What decides whether
 * a *declared* field may actually be written is the per-role allowlist in
 * `member-editable-fields.ts`, checked in the service: validation says "this is a well-formed
 * username", the allowlist says "you may not set one".
 */
export class PatchMemberDto extends ReasonedDto {
  @ApiPropertyOptional({ maxLength: 60 })
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  firstName?: string;

  @ApiPropertyOptional({ maxLength: 60, nullable: true })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(60)
  lastName?: string | null;

  @ApiPropertyOptional({ description: 'Lower case, 3–30 of `a-z 0-9 _ .`' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @Matches(USERNAME_PATTERN, {
    message: 'username must be 3–30 characters of a-z, 0-9, underscore or dot.',
  })
  username?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @MaxLength(254)
  @Matches(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, { message: 'email must be an email address.' })
  email?: string;

  @ApiPropertyOptional({ example: '+44', nullable: true })
  @IsOptional()
  @Trim()
  @IsString()
  @Matches(/^\+\d{1,4}$/, { message: 'phoneNumberDiallingCode must look like +44.' })
  phoneNumberDiallingCode?: string | null;

  @ApiPropertyOptional({
    description: 'At least 9 digits. Sent with the dialling code, or neither.',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(20)
  phoneNumber?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(60)
  cityId?: string;

  @ApiPropertyOptional({ enum: Gender, nullable: true })
  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender | null;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD. Must give an age of 18–110.' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dateOfBirth must be YYYY-MM-DD.' })
  dateOfBirth?: string;

  @ApiPropertyOptional({ description: 'ISO 3166-1 alpha-2, or null.', nullable: true })
  @IsOptional()
  @Trim()
  @IsString()
  @Matches(/^[A-Za-z]{2}$/, { message: 'countryOfOriginCode must be two letters.' })
  countryOfOriginCode?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(60)
  heritageTag?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(60)
  journeyStage?: string | null;

  @ApiPropertyOptional({ isArray: true })
  @IsOptional()
  @CsvArray()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  languages?: string[];

  @ApiPropertyOptional({ isArray: true })
  @IsOptional()
  @CsvArray()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  interests?: string[];

  @ApiPropertyOptional({ maxLength: 120, nullable: true })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(120)
  headline?: string | null;

  @ApiPropertyOptional({ maxLength: 600, nullable: true })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(600)
  bio?: string | null;

  @ApiPropertyOptional({ maxLength: 300, nullable: true })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(300)
  canHelpWith?: string | null;

  @ApiPropertyOptional({
    description: 'Only `true`. There is no way to set an avatar on a member’s behalf.',
  })
  @IsOptional()
  @IsBoolean()
  @IsIn([true], { message: 'removeAvatar can only be true.' })
  removeAvatar?: true;
}

/** Where an enforcement decision came from, so a strike can be traced back to the thing it was about. */
class EnforcementSourceDto extends ReasonedDto {
  @ApiPropertyOptional({ enum: EnforcementSourceType })
  @IsOptional()
  @IsEnum(EnforcementSourceType)
  sourceType?: EnforcementSourceType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sourceId?: string;

  @ApiPropertyOptional({ enum: ReportTargetType })
  @IsOptional()
  @IsEnum(ReportTargetType)
  sourceTargetType?: ReportTargetType;
}

export class SuspendMemberDto extends EnforcementSourceDto {
  @ApiProperty({ enum: SUSPENSION_DURATIONS })
  @IsIn(SUSPENSION_DURATIONS as unknown as string[])
  duration: SuspensionDuration;

  @ApiPropertyOptional({
    description: 'Required when `duration` is `custom`. Must be in the future.',
  })
  @IsOptional()
  @IsISO8601()
  until?: string;
}

export class WarnMemberDto extends EnforcementSourceDto {
  @ApiPropertyOptional({
    maxLength: 500,
    description: 'Shown to the member, verbatim. Omit and they get the policy reason alone.',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  message?: string;
}

export class ChangeSuspensionDto extends ReasonedDto {
  /**
   * The new end — and it has to be **sent**, even to clear it.
   *
   * `null` means indefinite; omitting the field is a mistake, not a request for one. Declared with
   * `ValidateIf` rather than `IsOptional` because the two are different answers and `IsOptional`
   * cannot tell them apart: it skips validation for `undefined` as well as `null`, so a typo in the
   * field name turned a seven-day suspension into a permanent one with no error anywhere.
   */
  @ApiProperty({
    nullable: true,
    required: true,
    description: 'The new end. `null` makes it indefinite. Must be sent either way.',
  })
  @ValidateIf(dto => dto.endsAt !== null)
  @IsISO8601()
  endsAt: string | null;
}

export class RevokeMemberSessionsDto extends ReasonedDto {
  @ApiPropertyOptional({ description: 'Omit to sign them out everywhere.' })
  @IsOptional()
  @IsUUID()
  sessionId?: string;
}

/**
 * An action whose whole body is the reason: unlock, reactivate, data-export, strike withdrawal.
 *
 * Its own name rather than reusing the revoke DTO, which carries a `sessionId`. A declared field is
 * an accepted field — `forbidNonWhitelisted` lets it through — so those four endpoints were
 * accepting a `sessionId` and ignoring it, which is a contract that lies about what it does.
 */
export class ReasonOnlyDto extends ReasonedDto {}

export class AnonymiseMemberDto extends ReasonedDto {
  @ApiProperty({
    description:
      "The member's username, or their id where they have none. Typed, not clicked: this cannot " +
      'be undone.',
  })
  @Trim()
  @IsString()
  @MaxLength(120)
  confirmUsername: string;
}

export class BulkRevokeSessionsDto extends ReasonedDto {
  @ApiProperty({ isArray: true, maxItems: 100 })
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  memberIds: string[];
}
