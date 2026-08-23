import { Sanitize } from '@/common';
import { ApiProperty } from '@nestjs/swagger';
import { Gender } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
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
    example: 'john_doe',
    description:
      'Unique handle. 3–30 characters; lowercase letters, numbers, underscores, and dots only.',
    pattern: '^[a-z][a-z0-9_.]{2,29}$',
    required: false,
  })
  @Matches(/^[a-z][a-z0-9_.]{2,29}$/, {
    message:
      'username must be 3–30 characters and contain only lowercase letters, numbers, underscores, and dots',
  })
  @IsString()
  @IsOptional()
  username?: string;

  @ApiProperty({
    example: 'LONDON',
    description: 'City ID from the cities list (e.g. "LONDON", "MANCHESTER")',
    required: false,
  })
  @Matches(/^[A-Z_]+$/, { message: 'cityId must be an uppercase city identifier (e.g. LONDON)' })
  @IsString()
  @IsOptional()
  cityId?: string;

  @ApiProperty({
    example: 'Nigeria',
    description: "User's country of origin",
    required: false,
  })
  @MaxLength(100, { message: 'countryOfOrigin must be 100 characters or fewer' })
  @IsString()
  @IsOptional()
  countryOfOrigin?: string;

  @ApiProperty({
    description: 'ITU E.164 dialling code with leading +. Accepts +1 to +999.',
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
    example: 'I moved to the UK in 2022. Love helping newcomers navigate life here.',
    description: 'Short personal bio shown on the community profile.',
    maxLength: 500,
    required: false,
  })
  @MaxLength(500, { message: 'bio must be 500 characters or fewer' })
  @IsString()
  @IsOptional()
  bio?: string;

  @ApiProperty({
    example: 'Visa applications, bank account setup, NHS registration',
    description: 'Topics the user can help others with — shown on their community profile.',
    maxLength: 500,
    required: false,
  })
  @MaxLength(500, { message: 'canHelpWith must be 500 characters or fewer' })
  @IsString()
  @IsOptional()
  canHelpWith?: string;

  @ApiProperty({
    example: true,
    description: 'When true, anyone can message the user directly.',
    required: false,
  })
  @IsBoolean({ message: 'openInbox must be a boolean' })
  @IsOptional()
  openInbox?: boolean;

  // ── The four shared fields (D15) ───────────────────────────────────────────
  // These live on the user rather than on a Connect profile or a professional
  // listing, because Connect, Professionals and Commerce all read them and a
  // second copy is guaranteed to disagree with the first.

  @ApiProperty({
    example: '1994-03-11',
    description:
      'YYYY-MM-DD. Collected once and never asked for again (D10). Changing it after it is set ' +
      'is a support action, not a self-service edit, because it is an age gate — a request to ' +
      'change it here returns 403 DOB_LOCKED.',
    required: false,
  })
  @IsDateString({}, { message: 'dateOfBirth must be a date in YYYY-MM-DD format' })
  @IsOptional()
  dateOfBirth?: string;

  @ApiProperty({
    type: [String],
    example: ['JOB_SEARCH', 'FOOD_COOKING'],
    description: 'Up to 8 interest codes. Shapes the feed, and prefills Connect setup.',
    required: false,
  })
  @IsArray()
  @ArrayMaxSize(8, { message: 'interests must have 8 entries or fewer' })
  @IsString({ each: true })
  @IsOptional()
  interests?: string[];

  @ApiProperty({
    type: [String],
    example: ['ENGLISH', 'YORUBA'],
    description: 'Up to 6 language codes.',
    required: false,
  })
  @IsArray()
  @ArrayMaxSize(6, { message: 'languages must have 6 entries or fewer' })
  @IsString({ each: true })
  @IsOptional()
  languages?: string[];

  @ApiProperty({
    example: 'WEST_AFRICAN',
    description: 'One heritage code. The same list Commerce uses for store tags (3.1.4).',
    required: false,
  })
  @IsString()
  @IsOptional()
  heritageTag?: string;

  @ApiProperty({
    example: 'JUST_ARRIVED',
    description:
      'One journey-stage code. Powers feed ranking and the Connect "new to the UK" filter.',
    required: false,
  })
  @IsString()
  @IsOptional()
  journeyStage?: string;

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
