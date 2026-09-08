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
  ValidateNested,
} from 'class-validator';
import { PageOptionsDto } from '@/common';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
const Bool = () => Transform(({ value }) => value === true || value === 'true');

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

  @ApiPropertyOptional({ default: false })
  @Bool()
  @IsBoolean()
  @IsOptional()
  includeArchived?: boolean;
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
    type: [String],
    description: 'Required for the media kinds. Max 5 images, or 1 video, or 1 audio.',
  })
  @IsArray()
  @ArrayMaxSize(5)
  @IsOptional()
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  attachmentKeys?: string[];

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
];

export class ThreadContextDto {
  @ApiProperty({
    enum: Object.keys(START_THREAD_CONTEXTS),
    description:
      'What the thread is about. `COMMERCE_ITEM` and `COMMUNITY_OFFER` are the names 4.5.3 uses; ' +
      '`ITEM` and `OFFER` are the same two under the enum names in 5.0.',
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
