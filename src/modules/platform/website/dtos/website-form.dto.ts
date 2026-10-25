import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';

/**
 * Trimmed before anything is measured.
 *
 * The website checks the same rules before it calls, counting characters after its own trim — so a
 * message of eleven characters padded with spaces has to pass here too, or the two sides disagree
 * about a form the visitor was told was fine. `Transform` runs before validation, which is what
 * makes `Length` count what the visitor actually wrote.
 */
const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/** Lowercased as well, because it is what a per-email limit and a later lookup compare. */
const TrimLower = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value));

export const CONTACT_TOPICS = [
  'GENERAL',
  'ACCOUNT',
  'PROS_AND_SELLERS',
  'PARTNERSHIPS',
  'PRESS',
] as const;

export const SUGGESTION_AREAS = [
  'COMMUNITY',
  'PROFESSIONALS',
  'CONNECT',
  'COMMERCE',
  'SOMETHING_NEW',
] as const;

export const DELETION_REASONS = [
  'NOT_USING',
  'PRIVACY',
  'BAD_EXPERIENCE',
  'OTHER_ACCOUNT',
  'OTHER',
] as const;

/**
 * The longest address the standard allows, and the ceiling on every address field here.
 *
 * Not decoration: `email` is indexed and compared, and a column with no length check is a column
 * somebody can put a megabyte in.
 */
const MAX_EMAIL = 254;

export class ContactMessageDto {
  @ApiProperty({ example: 'Amara Okafor', minLength: 1, maxLength: 60 })
  @IsString()
  @Trim()
  @Length(1, 60)
  name: string;

  @ApiProperty({ example: 'amara@example.com' })
  @IsEmail()
  @TrimLower()
  @MaxLength(MAX_EMAIL)
  email: string;

  @ApiProperty({ enum: CONTACT_TOPICS })
  @IsIn(CONTACT_TOPICS as unknown as string[])
  topic: (typeof CONTACT_TOPICS)[number];

  @ApiProperty({ minLength: 10, maxLength: 1200 })
  @IsString()
  @Trim()
  @Length(10, 1200)
  message: string;
}

export class FeatureSuggestionDto {
  @ApiProperty({ minLength: 3, maxLength: 80 })
  @IsString()
  @Trim()
  @Length(3, 80)
  title: string;

  @ApiProperty({ enum: SUGGESTION_AREAS })
  @IsIn(SUGGESTION_AREAS as unknown as string[])
  area: (typeof SUGGESTION_AREAS)[number];

  @ApiProperty({ minLength: 10, maxLength: 600 })
  @IsString()
  @Trim()
  @Length(10, 600)
  details: string;

  /** Optional, for somebody who would like to hear back. Left out when empty, never sent as `""`. */
  @ApiPropertyOptional({ example: 'tunde@example.com' })
  @IsOptional()
  @IsEmail()
  @TrimLower()
  @MaxLength(MAX_EMAIL)
  email?: string;
}

export class DeletionRequestDto {
  @ApiProperty({ example: 'Karim Haddad', minLength: 1, maxLength: 60 })
  @IsString()
  @Trim()
  @Length(1, 60)
  name: string;

  /** The address on the account, as the visitor remembers it. Never trusted to be theirs. */
  @ApiProperty({ example: 'karim@example.com' })
  @IsEmail()
  @TrimLower()
  @MaxLength(MAX_EMAIL)
  email: string;

  @ApiProperty({ enum: DELETION_REASONS })
  @IsIn(DELETION_REASONS as unknown as string[])
  reason: (typeof DELETION_REASONS)[number];

  @ApiPropertyOptional({ maxLength: 600 })
  @IsOptional()
  @IsString()
  @Trim()
  @MaxLength(600)
  details?: string;
}
