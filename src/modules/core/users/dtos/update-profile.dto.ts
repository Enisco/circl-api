import { IsValidBirthDate, Sanitize } from '@/common';
import { ApiProperty } from '@nestjs/swagger';
import { Gender, UnitPreference } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class UpdateProfileDto {
  @ApiProperty({
    example: 'https://r2.circl.app/avatars/user-uuid.jpg',
    description:
      "URL of the user's profile image. Upload the image first and pass the returned URL here.",
    required: false,
  })
  @IsUrl({}, { message: 'profileImageUrl must be a valid URL' })
  @IsOptional()
  profileImageUrl?: string;

  @ApiProperty({ example: 'John', minLength: 1, maxLength: 50, required: false })
  @Sanitize()
  @Matches(/^[a-zA-ZÀ-ÿ'\-\s]+$/, {
    message: 'firstName may only contain letters, spaces, hyphens, and apostrophes',
  })
  @MaxLength(50, { message: 'firstName must be 50 characters or fewer' })
  @MinLength(1, { message: 'firstName must be at least 1 character' })
  @IsString()
  @IsOptional()
  firstName?: string;

  @ApiProperty({ example: 'Doe', minLength: 1, maxLength: 50, required: false })
  @Sanitize()
  @Matches(/^[a-zA-ZÀ-ÿ'\-\s]+$/, {
    message: 'lastName may only contain letters, spaces, hyphens, and apostrophes',
  })
  @MaxLength(50, { message: 'lastName must be 50 characters or fewer' })
  @MinLength(1, { message: 'lastName must be at least 1 character' })
  @IsString()
  @IsOptional()
  lastName?: string;

  @ApiProperty({
    description: 'ITU E.164 dialling code without the leading +. Accepts +1 to +999.',
    example: '+44',
    pattern: '^\\+[1-9]\\d{0,3}$',
    required: false,
  })
  @Matches(/^\+[1-9]\d{0,3}$/, {
    message: 'phoneNumberDiallingCode must be a valid dialling code (e.g. +44, +1, +234)',
  })
  @IsString()
  @IsOptional()
  phoneNumberDiallingCode?: string;

  @ApiProperty({
    description: 'Subscriber number, digits only, 5–15 characters (no spaces or dashes)',
    example: '7911123456',
    pattern: '^[0-9]{5,15}$',
    required: false,
  })
  @Matches(/^[0-9]{5,15}$/, {
    message: 'phoneNumber must contain 5 to 15 digits with no spaces or dashes',
  })
  @IsString()
  @IsOptional()
  phoneNumber?: string;

  @ApiProperty({ enum: Gender, required: false })
  @IsEnum(Gender, { message: `gender must be one of: ${Object.values(Gender).join(', ')}` })
  @IsOptional()
  gender?: Gender;

  @ApiProperty({
    description: 'ISO 8601 date string. User must be at least 13 years old.',
    example: '1995-06-15',
    required: false,
  })
  @IsValidBirthDate()
  @IsISO8601({}, { message: 'dateOfBirth must be a valid ISO 8601 date (YYYY-MM-DD)' })
  @IsOptional()
  dateOfBirth?: string;

  @ApiProperty({ enum: UnitPreference, required: false })
  @IsEnum(UnitPreference, {
    message: `unitPreference must be one of: ${Object.values(UnitPreference).join(', ')}`,
  })
  @IsOptional()
  unitPreference?: UnitPreference;

  @ApiProperty({ example: false, required: false })
  @IsBoolean({ message: 'onboardingCompleted must be a boolean' })
  @IsOptional()
  onboardingCompleted?: boolean;

  @ApiProperty({ example: 1, minimum: 0, maximum: 10, required: false })
  @IsInt({ message: 'onboardingStep must be a whole number' })
  @Min(0, { message: 'onboardingStep must not be negative' })
  @Max(10, { message: 'onboardingStep must not exceed 10' })
  @IsOptional()
  onboardingStep?: number;
}
