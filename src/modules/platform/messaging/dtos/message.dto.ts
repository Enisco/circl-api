import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MessageKind, ThreadKind } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PageOptionsDto } from '@/common';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
const Bool = () => Transform(({ value }) => value === true || value === 'true');

export class ListConversationsDto extends PageOptionsDto {
  @ApiPropertyOptional({ enum: ThreadKind, description: 'Backs the filter tabs.' })
  @IsEnum(ThreadKind) @IsOptional()
  kind?: ThreadKind;

  @ApiPropertyOptional({ default: false, description: 'The Unread tab.' })
  @Bool() @IsBoolean() @IsOptional()
  unreadOnly?: boolean;

  @ApiPropertyOptional({
    description: 'Participant name, message body, and context title (D31).',
  })
  @Trim() @IsString() @IsOptional()
  q?: string;

  @ApiPropertyOptional({ default: false })
  @Bool() @IsBoolean() @IsOptional()
  includeArchived?: boolean;
}

/**
 * History is newest-first and cursor-paged. A chat scrolls backwards, so page
 * numbers over a list that grows at the head skip and repeat (5.3.3).
 */
export class ListMessagesDto {
  @ApiPropertyOptional({ description: 'Older than this message.' })
  @IsString() @IsOptional()
  before?: string;

  @ApiPropertyOptional({ description: 'Newer than this one. Used by `sync` after a reconnect.' })
  @IsString() @IsOptional()
  after?: string;

  @ApiPropertyOptional({ default: 30, maximum: 100 })
  @Type(() => Number) @IsInt() @Min(1) @Max(100) @IsOptional()
  limit?: number;
}

export class SendMessageDto {
  @ApiProperty({
    maxLength: 64,
    description:
      'Client-generated and unique per message. Echoed back in the acknowledgement so the pending ' +
      'bubble is replaced rather than duplicated, and it doubles as the idempotency key on a retry.',
  })
  @Trim() @IsString() @MinLength(1) @MaxLength(64)
  clientId: string;

  @ApiPropertyOptional({
    enum: [MessageKind.TEXT, MessageKind.IMAGE, MessageKind.VIDEO, MessageKind.AUDIO],
    default: MessageKind.TEXT,
    description: 'SYSTEM is server-only.',
  })
  @IsEnum(MessageKind) @IsOptional()
  kind?: MessageKind;

  @ApiPropertyOptional({
    maxLength: 4000,
    description: 'Required for TEXT, 1 to 4000 chars. An optional caption on media, max 1000.',
  })
  @Trim() @IsString() @MaxLength(4000) @IsOptional()
  body?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Required for the media kinds. Max 5 images, or 1 video, or 1 audio.',
  })
  @IsArray() @ArrayMaxSize(5) @IsOptional()
  attachmentIds?: string[];
}

export class StartThreadDto {
  @ApiProperty({
    description:
      'Only for a plain DM with no subject. Every subject-bearing thread is created by the section ' +
      'that owns the subject and returns its id.',
  })
  @Trim() @IsString()
  recipientUserId: string;
}

export class MarkReadDto {
  @ApiProperty({ description: 'Marks everything up to this message read, clearing a backlog in one call.' })
  @Trim() @IsString()
  lastReadMessageId: string;
}

export class MuteDto {
  @ApiPropertyOptional({ description: 'Null or omitted mutes indefinitely.' })
  @IsDateString() @IsOptional()
  until?: string;
}
