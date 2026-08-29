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
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class UpdateProfileDto {
  @ApiProperty({
    example: 'circl/avatars/9f2c.../1788000000-ab12cd34.jpg',
    description:
      'An object key under `circl/avatars/{userId}/`, obtained from POST /media/uploads with ' +
      'purpose AVATAR (0.11). An explicit `null` clears the photo back to initials; omitting ' +
      'the field leaves the current one alone.',
    nullable: true,
    required: false,
  })
  @MaxLength(512, { message: 'avatarKey must be 512 characters or fewer' })
  @IsString()
  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  avatarKey?: string | null;

  @ApiProperty({ example: 'John', minLength: 1, maxLength: 60, required: false })
  @Sanitize()
  @Matches(/^[a-zA-ZÀ-ÿ'\-\s]+$/, {
    message: 'firstName may only contain letters, spaces, hyphens, and apostrophes',
  })
  @MaxLength(60, { message: 'firstName must be 60 characters or fewer' })
  @MinLength(1, { message: 'firstName must be at least 1 character' })
  @IsString()
  @IsOptional()
  firstName?: string;

  @ApiProperty({
    example: 'Doe',
    maxLength: 60,
    nullable: true,
    required: false,
    description:
      'Nullable. The app has one name input and splits it on the first space, so a member ' +
      'with a single-word name sends nothing here (0.16.2).',
  })
  @Sanitize()
  @Matches(/^[a-zA-ZÀ-ÿ'\-\s]*$/, {
    message: 'lastName may only contain letters, spaces, hyphens, and apostrophes',
  })
  @MaxLength(60, { message: 'lastName must be 60 characters or fewer' })
  @IsString()
  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  lastName?: string | null;

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
  @MaxLength(120, { message: 'cityId must be 120 characters or fewer' })
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
    description: 'Subscriber number, digits only, 7–15 characters (no spaces or dashes)',
    example: '7911123456',
    pattern: '^[0-9]{7,15}$',
    required: false,
  })
  @Matches(/^[0-9]{7,15}$/, {
    message: 'phoneNumber must contain 7 to 15 digits with no spaces or dashes',
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
    description: 'Topics the user can help others with, shown on their community profile.',
    maxLength: 300,
    required: false,
  })
  @MaxLength(300, { message: 'canHelpWith must be 300 characters or fewer' })
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

  // ── The four shared fields (D15) ─────────────────────────────────────────── These live on the user rather than on a Connect profile or a professional listing, because Connect, Professionals and Commerce all read them and a second copy is guaranteed to disagree with the first.

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
