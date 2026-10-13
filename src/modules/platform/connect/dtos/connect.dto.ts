import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ConnectAboutKind, ConnectAccent, ConnectPostKind, DmPolicy } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CsvArray, PageOptionsDto, ToBoolean } from '@/common';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
const Bool = ToBoolean;

/**
 * One line under a name on a card. Long enough for "Final-year student, part-time barista" and
 * short enough that the card never has to decide where to break.
 */
export const OCCUPATION_MAX = 60;

export class PromptAnswerDto {
  @ApiProperty({ description: 'A CONNECT_PROMPT code.' })
  @Trim()
  @IsString()
  code: string;

  @ApiProperty({
    maxLength: 200,
    description:
      'Bounded here only against the absurd. The real floor and ceiling are ' +
      '`taxonomy.limits.minPromptAnswer` and `maxPromptAnswer`, enforced in the service so staff ' +
      'can move them without a release — and so the refusal names the limit it broke.',
  })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  answer: string;
}

/** One idempotent upsert for both create and edit, because the setup screen is the same screen either way (3.3.1). */
export class UpsertConnectProfileDto {
  @ApiProperty({
    description: 'A connection type code: FRIENDSHIP, NETWORKING, LANGUAGE_EXCHANGE, and so on.',
  })
  @Trim()
  @IsString()
  typeCode: string;

  @ApiProperty({ minLength: 10, maxLength: 500, description: 'The form blocks below 10.' })
  @Trim()
  @IsString()
  @MinLength(10, { message: 'lookingFor must be at least 10 characters' })
  @MaxLength(500, { message: 'lookingFor must be 500 characters or fewer' })
  lookingFor: string;

  @ApiPropertyOptional({ enum: DmPolicy, default: DmPolicy.REQUEST_FIRST })
  @IsEnum(DmPolicy)
  @IsOptional()
  dmPolicy?: DmPolicy;

  @ApiPropertyOptional({
    enum: ConnectAccent,
    nullable: true,
    description:
      'The colour the member picked, and the first thing a reader sees. One of a fixed set ' +
      'rather than a hex value: each has been checked against white text, which a free colour ' +
      'cannot promise. Anything else is rejected rather than stored; absent leaves it alone and ' +
      "`null` clears it back to the connection type's colour.",
  })
  @IsEnum(ConnectAccent)
  @IsOptional()
  accentColour?: ConnectAccent | null;

  @ApiPropertyOptional({
    default: false,
    description: 'Off by default. Opting in to be discoverable is a deliberate act.',
  })
  @Bool()
  @IsBoolean()
  @IsOptional()
  isVisible?: boolean;

  @ApiPropertyOptional({
    description:
      'Only when the user has none. Rejected with DOB_LOCKED otherwise, because it is an age gate.',
  })
  @IsDateString()
  @IsOptional()
  dateOfBirth?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Max 6. Prefilled, and written through to the USER record (3.1.3).',
  })
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  @IsOptional()
  languages?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'Max 8. Prefilled, and written through to the user — these also shape the feed.',
  })
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  @IsOptional()
  interests?: string[];

  @ApiPropertyOptional({
    type: [String],
    description:
      'HOBBY codes — what the member is into, shown on the Meet card. A **different vocabulary ' +
      'from `interests`**, whose first fifteen codes are community categories so the feed ranker ' +
      'can match a post against them; both are sent, and neither replaces the other. Capped by ' +
      '`taxonomy.limits.maxHobbies`, which is read from configuration rather than from this ' +
      'decorator — so a refusal is `422 TOO_MANY_HOBBIES` with the limit in `data` rather than a ' +
      'validator complaining about an array length. An empty array clears them.',
  })
  @IsArray()
  // A backstop, not the rule. `maxHobbies` is the rule, and it lives in configuration.
  @ArrayMaxSize(40)
  @IsString({ each: true })
  @IsOptional()
  hobbies?: string[];

  @ApiPropertyOptional({
    type: [String],
    description:
      'The photographs that **are** the card, in swipe order (v2 §1). `Media` ids, as they come ' +
      'back on `posts[].items[].id`, and they have to be photos already on one of this ' +
      'profile’s own posts — a card photo that exists nowhere else would be a face in Browse ' +
      'that a visitor cannot find once they open the profile. A video id is refused, for the ' +
      'same reason the field is called photos.\n\n' +
      '`cardPhotoIds[0]` is the cover everywhere a cover is used. Capped by ' +
      '`taxonomy.limits.maxCardPhotos`, read from configuration rather than from this decorator. ' +
      'An unknown or ineligible id is `422 UNKNOWN_MEDIA` naming it in `data.unknown`, rather ' +
      'than being dropped quietly.\n\n' +
      '**Omitting it leaves the card alone; an empty array restores post order**, which is what ' +
      'every profile did before this field existed.',
  })
  @IsArray()
  // A backstop, not the rule. `maxCardPhotos` is the rule, and it lives in configuration.
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @IsOptional()
  cardPhotoIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    description:
      'What they are **learning**, for Language Exchange (v2 §7). The same `LANGUAGE` ' +
      'vocabulary as `languages`, which is what they already speak — the difference is the whole ' +
      'point: two people who both speak English and are both learning Spanish are looking for ' +
      'each other. Capped by `taxonomy.limits.maxLanguages`. An empty array clears them.',
  })
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  @IsOptional()
  learningLanguages?: string[];

  @ApiPropertyOptional({
    maxLength: OCCUPATION_MAX,
    nullable: true,
    description:
      'What they do, under the name on the Meet card. **Free text rather than a profession ' +
      'code, deliberately:** Connect is not a directory, and "Final-year student", "Between ' +
      'jobs" and "Nurse, nights" are all answers somebody would give. Omitting it leaves it ' +
      'alone; an empty string or `null` clears it.',
  })
  @Trim()
  @IsString()
  @MaxLength(OCCUPATION_MAX)
  @IsOptional()
  occupation?: string | null;

  @ApiPropertyOptional({
    type: [String],
    description:
      "Upload keys, purpose `CONNECT`, which become the profile's first post in the order " +
      'given. **Required when the profile is being created**, where there must be at least ' +
      '`taxonomy.limits.minConnectPhotos` of them; ignored on an edit, so a profile from before ' +
      'that rule can still be edited without being made to find two more pictures first. Adding ' +
      'posts later is still `POST /connect/me/posts`.\n\n' +
      'Sent here rather than posted afterwards because a profile and its photos are then one ' +
      'write: there is no window in which a profile exists with nothing on it.',
  })
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  @IsOptional()
  photoKeys?: string[];

  @ApiPropertyOptional({
    type: [PromptAnswerDto],
    description:
      'The whole set, max 3, same shape as `PUT /connect/me/prompts`. **At least one is required ' +
      'when the profile is being created**; omitted on an edit it leaves the existing answers ' +
      'alone, and an empty array clears them. Written in the same transaction as the profile, so ' +
      'the safety scan reads the answers along with `lookingFor` rather than a moment later.',
  })
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => PromptAnswerDto)
  @IsOptional()
  prompts?: PromptAnswerDto[];

  @ApiPropertyOptional({ description: 'One heritage code. Written through to the user.' })
  @Trim()
  @IsString()
  @IsOptional()
  heritageTag?: string;

  @ApiPropertyOptional({
    description:
      'Only if the member wants to be found in a city they are moving to. Never touches ' +
      'profile.cityId, which the rest of the app trusts (D18).',
  })
  @Trim()
  @IsString()
  @IsOptional()
  cityIdOverride?: string;

  @ApiPropertyOptional({
    description:
      'Required when typeCode is DATING. The client shows an extra confirm step reiterating 18+ ' +
      'and the safety block, and the server records that the confirmation was given and when.',
  })
  @Bool()
  @IsBoolean()
  @IsOptional()
  datingConfirmed?: boolean;
}

export class DiscoveryDto extends PageOptionsDto {
  @ApiPropertyOptional({ description: 'A connection type code.' })
  @Trim()
  @IsString()
  @IsOptional()
  type?: string;

  @ApiPropertyOptional({ description: 'Clamped to 18 whatever is sent.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(120)
  @IsOptional()
  minAge?: number;

  @ApiPropertyOptional()
  @Type(() => Number)
  @IsInt()
  @Min(18)
  @Max(120)
  @IsOptional()
  maxAge?: number;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  cityId?: string;

  @ApiPropertyOptional({ description: 'Matches the bio and what the member can help with.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsOptional()
  q?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Matches if the profile speaks ANY of them.',
  })
  @CsvArray()
  @IsArray()
  @IsOptional()
  languages?: string[];

  @ApiPropertyOptional({ type: [String] })
  @CsvArray()
  @IsArray()
  @IsOptional()
  heritage?: string[];

  @ApiPropertyOptional({
    description:
      'Journey stage PLANNING or JUST_ARRIVED. Defined once server-side, so the chip and the query ' +
      'cannot drift.',
  })
  @Bool()
  @IsBoolean()
  @IsOptional()
  newToUk?: boolean;

  @ApiPropertyOptional({
    description:
      'Accepted but hidden in the client this version (D13): nothing carries an identity check yet, ' +
      'so the filter would always return nothing.',
  })
  @Bool()
  @IsBoolean()
  @IsOptional()
  verifiedOnly?: boolean;

  @ApiPropertyOptional({ enum: ['RECOMMENDED', 'RECENT', 'NEAREST'], default: 'RECOMMENDED' })
  @IsIn(['RECOMMENDED', 'RECENT', 'NEAREST'])
  @IsOptional()
  sort?: 'RECOMMENDED' | 'RECENT' | 'NEAREST';
}

export class ConnectAboutDto {
  @ApiProperty({ enum: ConnectAboutKind })
  @IsEnum(ConnectAboutKind)
  kind: ConnectAboutKind;

  @ApiProperty({
    description:
      'For MEDIA, an **item** id from inside a post — not the post id, because somebody is ' +
      'saying something about the exact frame they are looking at. For PROMPT, the prompt code. ' +
      '422 where it does not belong to that profile.',
  })
  @Trim()
  @IsString()
  id: string;
}

export class CreateConnectionRequestDto {
  @ApiProperty()
  @Trim()
  @IsString()
  toProfileId: string;

  @ApiPropertyOptional({
    maxLength: 300,
    description:
      'Optional, and absent is the common case: a request with `about` and no note is the heart ' +
      '(3.5.1). Never rejected for being absent or empty.',
  })
  @Trim()
  @IsString()
  @MaxLength(300)
  @IsOptional()
  note?: string;

  @ApiPropertyOptional({
    type: ConnectAboutDto,
    description:
      'What the request is about. Carried onto the conversation, so the first message arrives ' +
      'quoted against that photo or answer rather than being "hey".',
  })
  @ValidateNested()
  @Type(() => ConnectAboutDto)
  @IsOptional()
  about?: ConnectAboutDto;
}

export class CreateConnectPostDto {
  @ApiProperty({
    type: [String],
    description:
      'Upload keys, purpose `CONNECT`. **Every key in one call is one post**, in the order ' +
      'given: the grouping is the call, not the upload. Up to 5 with `kind: PHOTO`, exactly 1 ' +
      'with `kind: VIDEO`.',
  })
  @IsArray()
  @ArrayMinSize(1)
  // Deliberately looser than the five-photo rule so the service decides: a sixth key then answers
  // `409 CONNECT_POST_LIMIT` with the limit in `data`, which is a refusal worth showing, rather
  // than a `400` from the validator about an array length.
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  keys: string[];

  @ApiProperty({
    enum: ConnectPostKind,
    description: 'A post is one or the other, never a mix. Enforced here as well as on the client.',
  })
  @IsEnum(ConnectPostKind)
  kind: ConnectPostKind;

  @ApiPropertyOptional({
    maxLength: 140,
    description:
      'Plain text, about the moment rather than one frame of it. The markup rules do not apply.',
  })
  @Trim()
  @IsString()
  @MaxLength(140)
  @IsOptional()
  caption?: string;

  @ApiPropertyOptional({
    description:
      '**Required when `kind` is VIDEO.** One frame of the clip, uploaded as an image, which ' +
      "becomes the video's `thumbnailUrl`. Nothing here derives a poster from a video, and a " +
      'clip handed to an image loader is a grey square — so the frame comes from the device that ' +
      'already decoded it.',
  })
  @Trim()
  @IsString()
  @IsOptional()
  posterKey?: string;
}

export class UpdateConnectPostDto {
  @ApiPropertyOptional({ maxLength: 140, nullable: true })
  @Trim()
  @IsString()
  @MaxLength(140)
  @IsOptional()
  caption?: string;
}

export class ReorderPostsDto {
  @ApiProperty({
    type: [String],
    description:
      "The whole list in the new order. Rejected unless these are exactly this profile's posts, " +
      'once each, so a stale client cannot drop one by leaving it out.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(9)
  @IsString({ each: true })
  ids: string[];
}

export class UpsertPromptsDto {
  @ApiProperty({
    type: [PromptAnswerDto],
    description:
      'The whole set, max 3, which is what keeps the order the owner chose. An empty array ' +
      'clears them.',
  })
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => PromptAnswerDto)
  prompts: PromptAnswerDto[];
}

export class CreateConnectStoryDto {
  @ApiProperty({ description: 'One upload key, purpose `CONNECT`.' })
  @Trim()
  @IsString()
  key: string;

  @ApiPropertyOptional({
    description: "A still frame, where the story is a video. Same reason as a post's poster.",
  })
  @Trim()
  @IsString()
  @IsOptional()
  posterKey?: string;

  @ApiPropertyOptional({
    maxLength: 140,
    description:
      'One line, plain text, the same cap as a post caption — a photograph of a plate of food ' +
      'says nothing until somebody says where it was. Absent and empty are the same thing.',
  })
  @Trim()
  @IsString()
  @MaxLength(140)
  @IsOptional()
  caption?: string;

  @ApiPropertyOptional({
    enum: ConnectPostKind,
    deprecated: true,
    description:
      'Accepted and **ignored**: the type comes from the upload itself, so a client declaring it ' +
      'cannot disagree with the bytes. Here because sending it used to be a 400 — after the ' +
      'photo was already in the bucket, which is the worst order for that to happen in.',
  })
  @IsEnum(ConnectPostKind)
  @IsOptional()
  kind?: ConnectPostKind;
}

export class ListConnectionRequestsDto extends PageOptionsDto {
  @ApiPropertyOptional({ enum: ['RECEIVED', 'SENT'], default: 'RECEIVED' })
  @IsIn(['RECEIVED', 'SENT'])
  @IsOptional()
  direction?: 'RECEIVED' | 'SENT';

  @ApiPropertyOptional({
    enum: ['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'ALL'],
    default: 'PENDING',
  })
  @IsIn(['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'ALL'])
  @IsOptional()
  state?: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'ALL';
}

export class DeclineRequestDto {
  @ApiPropertyOptional({
    default: false,
    description: "The decline sheet's second option. Applied in the same transaction.",
  })
  @Bool()
  @IsBoolean()
  @IsOptional()
  alsoBlock?: boolean;
}
