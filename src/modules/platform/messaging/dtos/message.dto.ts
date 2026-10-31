import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MessageKind, ThreadContextType, ThreadKind } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
  Validate,
  ValidateNested,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { PageOptionsDto, ToBoolean } from '@/common';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
const Bool = ToBoolean;

export class ListConversationsDto extends PageOptionsDto {
  @ApiPropertyOptional({ enum: ThreadKind, description: 'Backs the filter tabs.' })
  @IsEnum(ThreadKind)
  @IsOptional()
  kind?: ThreadKind;

  @ApiPropertyOptional({ default: false, description: 'The Unread tab.' })
  @Bool()
  @IsBoolean()
  @IsOptional()
  unreadOnly?: boolean;

  @ApiPropertyOptional({
    description: 'Participant name, message body, and context title (D31).',
  })
  @Trim()
  @IsString()
  @IsOptional()
  q?: string;

  @ApiPropertyOptional({ default: false, description: 'Active and archived together.' })
  @Bool()
  @IsBoolean()
  @IsOptional()
  includeArchived?: boolean;

  @ApiPropertyOptional({
    default: false,
    description:
      'The Done chip: `true` returns **only** archived threads. A third state rather than a ' +
      'replacement for `includeArchived`, because "the ones I have finished with" is a different ' +
      'question from "everything". Wins over `includeArchived` when both are sent.',
  })
  @Bool()
  @IsBoolean()
  @IsOptional()
  archived?: boolean;
}

/** History is newest-first and cursor-paged. */
export class ListMessagesDto {
  @ApiPropertyOptional({
    description:
      'Older than this message. Send `meta.nextCursor` from the previous page rather than the ' +
      'oldest id you hold, so paging survives a message being removed.',
  })
  @Trim()
  @IsString()
  @IsOptional()
  before?: string;

  @ApiPropertyOptional({ description: 'Newer than this one. Used by `sync` after a reconnect.' })
  @Trim()
  @IsString()
  @IsOptional()
  after?: string;

  @ApiPropertyOptional({
    description:
      'Everything **changed** at or after this ISO timestamp, oldest first: sent, edited and ' +
      'deleted, tombstones included. For reconciling a cached window, where `after` cannot help ' +
      'because it only reports what is newer, never what changed.\n\n' +
      'Page it with `after` (`since` stays on every call, `after` carries `meta.nextCursor`). ' +
      'Combining it with `before` is a `400`: it reads forwards.',
    example: '2026-09-07T09:00:00.000Z',
  })
  @Trim()
  @IsDateString()
  @IsOptional()
  since?: string;

  @ApiPropertyOptional({ default: 30, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number;
}

/**
 * One emoji, as the keyboard produced it. A grapheme rather than a code point, so a skin tone or a
 * ZWJ sequence survives: `👍🏾` is not `👍`, and required to be pictographic so the chips do not turn
 * into a text field.
 *
 * 32 bytes rather than the 16 the client suggested: the grapheme check is what guarantees one
 * emoji, and 16 refuses real ones. A three-person family (`👩‍👩‍👧`) is 18 bytes and the Scottish
 * flag is 28. The cap is only a bound against a pathological ZWJ chain.
 */
@ValidatorConstraint({ name: 'isSingleEmoji', async: false })
class IsSingleEmojiConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string' || !value) return false;
    if (Buffer.byteLength(value, 'utf8') > 32) return false;

    // One user-perceived character. A segmenter is the only thing that counts them correctly: a
    // ZWJ family is eleven code points and one emoji.
    const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

    if ([...segmenter.segment(value)].length !== 1) return false;

    return /\p{Extended_Pictographic}/u.test(value);
  }

  defaultMessage(): string {
    return 'emoji must be a single emoji, 16 bytes or fewer';
  }
}

export class ReactDto {
  @ApiProperty({
    example: '👍',
    description:
      'A single emoji, stored as the Unicode sequence you send — skin tone and ZWJ included, ' +
      'because `👍🏾` is not `👍`. One reaction per member per message, so this replaces any ' +
      'previous one rather than adding to it. Up to 32 bytes: 16 would refuse a three-person ' +
      'family and a subdivision flag, and the single-grapheme rule is what keeps it to one emoji.',
  })
  @Validate(IsSingleEmojiConstraint)
  emoji: string;
}

export class EditMessageDto {
  @ApiProperty({ minLength: 1, maxLength: 4000 })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body: string;
}

export class MentionDto {
  @ApiProperty({ description: 'Must be somebody in this thread; anybody else is dropped.' })
  @Trim()
  @IsString()
  userId: string;

  @ApiProperty({
    description:
      'UTF-16 code units from the start of `body`, which is what the client measures in. Stored ' +
      'as sent rather than recomputed from the text.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number;

  @ApiProperty({ description: 'Covers the `@Name` run.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  length: number;
}

/**
 * Where a message came from, when that is not what the thread is about (5.0).
 *
 * The one case is Connect: two people have one conversation, and "this came from their Language
 * Exchange profile" belongs on the message rather than on the thread. A long conversation may
 * carry several tags and none of them splits it.
 *
 * Stored as sent and echoed back on the message, with no lookup — it is a label, not an
 * authorisation, and a profile deleted a month later must not make an old message unreadable.
 */
export class MessageTagDto {
  @ApiProperty({ enum: ThreadContextType, example: ThreadContextType.CONNECT_PROFILE })
  @IsEnum(ThreadContextType)
  kind: ThreadContextType;

  @ApiProperty({ maxLength: 64 })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  id: string;
}

export class SendMessageDto {
  @ApiProperty({
    maxLength: 64,
    description:
      'Client-generated and unique per message. Echoed back in the acknowledgement so the pending ' +
      'bubble is replaced rather than duplicated, and it doubles as the idempotency key on a retry.',
  })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  clientId: string;

  @ApiPropertyOptional({
    enum: [MessageKind.TEXT, MessageKind.IMAGE, MessageKind.VIDEO, MessageKind.AUDIO],
    default: MessageKind.TEXT,
    description: 'SYSTEM is server-only.',
  })
  @IsEnum(MessageKind)
  @IsOptional()
  kind?: MessageKind;

  @ApiPropertyOptional({
    maxLength: 4000,
    description: 'Required for TEXT, 1 to 4000 chars. An optional caption on media, max 1000.',
  })
  @Trim()
  @IsString()
  @MaxLength(4000)
  @IsOptional()
  body?: string;

  @ApiPropertyOptional({
    description:
      'Swipe to reply. 422 where that message is not in this conversation. The payload then ' +
      'carries a `replyTo` snapshot, resolved on read so a withdrawn original quotes as withdrawn.',
  })
  @Trim()
  @IsString()
  @IsOptional()
  replyToMessageId?: string;

  @ApiPropertyOptional({
    type: [MentionDto],
    description:
      'The body carries the plain text (`Can you take this one, @Ada Obi?`) and the positions ' +
      'travel beside it. Anybody who is not in the thread is dropped rather than refused — a ' +
      'mention of somebody who left is not a reason to lose the message. A mention notifies even ' +
      'when the group is muted.',
  })
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => MentionDto)
  @IsOptional()
  mentions?: MentionDto[];

  @ApiPropertyOptional({
    description:
      'Passes a message on. Its attachments are copied server-side, so a forward never ' +
      're-uploads. The caller has to be able to read the source thread, and `isForwarded` comes ' +
      'back true whether this or the flag below set it.',
  })
  @Trim()
  @IsString()
  @IsOptional()
  forwardFromMessageId?: string;

  @ApiPropertyOptional({
    description:
      'For a forward the client assembled itself, such as plain text. Implied by ' +
      '`forwardFromMessageId`, so only send it on its own.',
  })
  @Bool()
  @IsBoolean()
  @IsOptional()
  isForwarded?: boolean;

  @ApiPropertyOptional({
    type: [String],
    description: 'Required for the media kinds. Max 5 images, or 1 video, or 1 audio.',
  })
  @IsArray()
  @ArrayMaxSize(5)
  @IsOptional()
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  attachmentKeys?: string[];

  @ApiPropertyOptional({
    type: MessageTagDto,
    description:
      'Where this message came from, when the thread is not about it — today, the Connect ' +
      'profile the sender wrote from. Echoed back on the message in `GET /messages/:id/messages`. ' +
      'It never changes which thread the message lands in.',
  })
  @ValidateNested()
  @Type(() => MessageTagDto)
  @IsOptional()
  tag?: MessageTagDto;

  /** The same keys under the name an early client shipped: uploads only ever return a `key`. */
  @ApiPropertyOptional({
    type: [String],
    deprecated: true,
    description: 'Deprecated alias for `attachmentKeys`. Same S3 object keys, old name.',
  })
  @IsArray()
  @ArrayMaxSize(5)
  @IsOptional()
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  attachmentIds?: string[];
}

/**
 * The subjects a member starts a thread about from a screen. Everything else is created by the
 * section that owns it, at the moment the subject exists; these have no such moment.
 */
export const START_THREAD_CONTEXTS = {
  COMMERCE_ITEM: ThreadContextType.ITEM,
  COMMUNITY_OFFER: ThreadContextType.OFFER,
  COMMUNITY_REQUEST: ThreadContextType.REQUEST,
  PROFESSIONAL: ThreadContextType.PROFESSIONAL,
  SERVICE: ThreadContextType.SERVICE,
  CONNECT_PROFILE: ThreadContextType.CONNECT_PROFILE,
  STORE: ThreadContextType.STORE,
  // The enum's own names, accepted because half the spec writes them this way (5.0) and rejecting
  // a synonym helps nobody.
  ITEM: ThreadContextType.ITEM,
  OFFER: ThreadContextType.OFFER,
  REQUEST: ThreadContextType.REQUEST,
} as const;

/**
 * The subjects that name the other person by themselves. A request does not: it has as many
 * helpers as answered it, so it needs `recipientUserId` too.
 */
export const CONTEXTS_THAT_NAME_THE_RECIPIENT: readonly ThreadContextType[] = [
  ThreadContextType.ITEM,
  ThreadContextType.OFFER,
  ThreadContextType.PROFESSIONAL,
  ThreadContextType.SERVICE,
  ThreadContextType.CONNECT_PROFILE,
  ThreadContextType.STORE,
];

/** The section a thread files under, which is the context's, not the participants' (5.0.1). */
export const KIND_FOR_CONTEXT: Record<ThreadContextType, ThreadKind> = {
  [ThreadContextType.GROUP]: ThreadKind.GROUP,
  [ThreadContextType.REQUEST]: ThreadKind.COMMUNITY,
  [ThreadContextType.OFFER]: ThreadKind.COMMUNITY,
  [ThreadContextType.PROFESSIONAL]: ThreadKind.PROFESSIONAL,
  // A thread opened by accepting a service request files under Professional, like every other
  // conversation between a member and somebody they are hiring.
  [ThreadContextType.SERVICE_REQUEST]: ThreadKind.PROFESSIONAL,
  [ThreadContextType.SERVICE]: ThreadKind.PROFESSIONAL,
  [ThreadContextType.BOOKING]: ThreadKind.PROFESSIONAL,
  [ThreadContextType.CONNECT_PROFILE]: ThreadKind.CONNECT,
  [ThreadContextType.ITEM]: ThreadKind.COMMERCE,
  [ThreadContextType.ORDER]: ThreadKind.COMMERCE,
  [ThreadContextType.STORE]: ThreadKind.COMMERCE,
  [ThreadContextType.SUPPORT]: ThreadKind.SUPPORT,
  [ThreadContextType.BRIEF]: ThreadKind.SUPPORT,
  [ThreadContextType.MANAGED_REQUEST]: ThreadKind.SUPPORT,
  [ThreadContextType.DISPUTE]: ThreadKind.SUPPORT,
};

/** A thread about nothing in particular is the only DIRECT one. */
export const kindForContext = (contextType: ThreadContextType | null): ThreadKind =>
  contextType ? KIND_FOR_CONTEXT[contextType] : ThreadKind.DIRECT;

/**
 * "Is there already a thread about this?", asked without creating one (5.3.5).
 *
 * The inbox answers it for the threads a device has loaded and cannot answer it past the first
 * page, and `POST /messages` answers it by creating the thread — which is the wrong answer to a
 * question. One read, 200 with the thread or 404 with nothing.
 */
export class FindThreadDto {
  @ApiProperty({
    enum: Object.keys(START_THREAD_CONTEXTS),
    description: 'The same names `POST /messages` takes, aliases and all.',
    example: 'OFFER',
  })
  @Trim()
  @IsIn(Object.keys(START_THREAD_CONTEXTS))
  contextType: keyof typeof START_THREAD_CONTEXTS;

  @ApiProperty({ description: 'The subject id, as the record carries it.' })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  contextId: string;
}

export class ThreadContextDto {
  @ApiProperty({
    enum: Object.keys(START_THREAD_CONTEXTS),
    description:
      'What the thread is about. `COMMERCE_ITEM` and `COMMUNITY_OFFER` are the names 4.5.3 uses; ' +
      '`ITEM` and `OFFER` are the same two under the enum names in 5.0. `PROFESSIONAL` takes a ' +
      'listing id, `SERVICE` one service off that listing, `CONNECT_PROFILE` a Connect profile id ' +
      'and `STORE` a store id, each of which has one owner, so none of them needs ' +
      '`recipientUserId`. Prefer `SERVICE` wherever the listing has services: two services with ' +
      'the same professional are two threads, as two shop items are.',
    example: 'COMMERCE_ITEM',
  })
  @Trim()
  @IsIn(Object.keys(START_THREAD_CONTEXTS))
  kind: keyof typeof START_THREAD_CONTEXTS;

  @ApiPropertyOptional({
    description: 'The subject id. `itemId` and `offerId` are accepted aliases.',
  })
  @Trim()
  @IsString()
  @IsOptional()
  id?: string;

  @ApiPropertyOptional({ description: 'Alias for `id` when `kind` is COMMERCE_ITEM.' })
  @Trim()
  @IsString()
  @IsOptional()
  itemId?: string;

  @ApiPropertyOptional({ description: 'Alias for `id` when `kind` is COMMUNITY_OFFER.' })
  @Trim()
  @IsString()
  @IsOptional()
  offerId?: string;
}

export class StartThreadDto {
  @ApiPropertyOptional({
    description:
      'The member to talk to. **Optional when `context` is sent**, because the server derives the ' +
      "other party from the subject: the item's seller, the offer's author. Send it anyway if " +
      'you like — it is checked against the derived member and a mismatch is rejected rather ' +
      'than quietly opening a thread with the wrong person.',
  })
  @Trim()
  @IsString()
  @IsOptional()
  recipientUserId?: string;

  @ApiPropertyOptional({
    type: ThreadContextDto,
    description:
      'What the thread is about, when it is about something. Threads are unique on ' +
      '(participants, contextType, contextId), so asking about two different items opens two ' +
      'threads and asking about the same item twice reopens the first.\n\n' +
      'Omit it for a plain DM. Every other subject-bearing thread is created by the section that ' +
      'owns the subject and returns its id (5.0, rule 3).',
  })
  @ValidateNested()
  @Type(() => ThreadContextDto)
  @IsOptional()
  context?: ThreadContextDto;
}

export class MarkReadDto {
  @ApiPropertyOptional({
    description:
      'Marks everything up to this message read, clearing a backlog in one call.\n\n' +
      '**Optional.** Omit it to mark the whole thread read, which is what opening a thread means ' +
      'and the only thing a thread with no messages in it yet can be asked for. The response then ' +
      'carries `lastReadMessageId: null`, because nothing was read.',
  })
  @Trim()
  @IsString()
  @IsOptional()
  lastReadMessageId?: string;
}

export class MuteDto {
  @ApiPropertyOptional({ description: 'Null or omitted mutes indefinitely.' })
  @IsDateString()
  @IsOptional()
  until?: string;
}
