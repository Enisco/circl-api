import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SupportThreadState, SupportThreadType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AdminPageOptionsDto, CsvArray, ToBoolean } from '@/common';
import { SendMessageDto } from '@/modules/platform/messaging';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
const Bool = ToBoolean;

/** The three views the inbox tabs are (§5.15). `all` is everything the caller may see. */
export const SUPPORT_VIEWS = ['unassigned', 'mine', 'all'] as const;
export type SupportView = (typeof SUPPORT_VIEWS)[number];

/**
 * The default `state` filter: the threads that are still somebody's work.
 *
 * `WAITING_ON_MEMBER` is in it, which is worth saying out loud — a thread we have answered and are
 * waiting on is not finished, and leaving it out of the default would mean a reply that never came
 * disappears from the inbox the moment staff send theirs.
 */
export const OPEN_SUPPORT_STATES: SupportThreadState[] = [
  SupportThreadState.NEW,
  SupportThreadState.OPEN,
  SupportThreadState.WAITING_ON_MEMBER,
];

/** The settled states, for the "done" tab. */
export const DONE_SUPPORT_STATES: SupportThreadState[] = [
  SupportThreadState.RESOLVED,
  SupportThreadState.CLOSED,
];

/** The sorts the inbox offers. An allowlist, so `sort` cannot name an arbitrary column. */
export const SUPPORT_SORTS = ['lastMemberMessageAt', 'createdAt', 'waitingSince'] as const;
export type SupportSort = (typeof SUPPORT_SORTS)[number];

export class ListSupportThreadsDto extends AdminPageOptionsDto {
  @ApiPropertyOptional({
    enum: SUPPORT_VIEWS,
    default: 'all',
    description:
      '`unassigned` is nobody’s yet, `mine` is assigned to the caller. Both are narrower than ' +
      'the `assignedToId` filter rather than a different thing: `mine` is `assignedToId=<me>`, ' +
      'named so the portal does not have to know who it is signed in as.',
  })
  @Trim()
  @IsIn([...SUPPORT_VIEWS])
  @IsOptional()
  view?: SupportView;

  @ApiPropertyOptional({
    description:
      'Comma-separated states. Defaults to `NEW,OPEN,WAITING_ON_MEMBER` — everything still open. ' +
      'The done tab is `RESOLVED,CLOSED`.',
  })
  @CsvArray()
  @IsEnum(SupportThreadState, { each: true })
  @IsOptional()
  state?: SupportThreadState[];

  @ApiPropertyOptional({
    description:
      'Comma-separated types. `GUARD` is only ever returned to a caller holding `guard:read`, ' +
      'and asking for it without that permission narrows to nothing rather than refusing.',
  })
  @CsvArray()
  @IsEnum(SupportThreadType, { each: true })
  @IsOptional()
  type?: SupportThreadType[];

  @ApiPropertyOptional({ description: 'Threads assigned to this staff member.' })
  @Trim()
  @IsString()
  @IsOptional()
  assignedToId?: string;

  @ApiPropertyOptional({ description: 'Threads with this member.' })
  @Trim()
  @IsString()
  @IsOptional()
  memberId?: string;

  @ApiPropertyOptional({
    description:
      'No first response inside `support.firstResponseSlaMinutes`. Only counts threads still ' +
      'open: a resolved thread stopped the clock, and one Circl opened has no response to be ' +
      'late with until the member writes.',
  })
  @Bool()
  @IsBoolean()
  @IsOptional()
  overdue?: boolean;

  @ApiPropertyOptional({
    enum: SUPPORT_SORTS,
    default: 'lastMemberMessageAt',
    description:
      '`waitingSince` is "longest wait first" and ignores threads nobody is waiting on — they ' +
      'sort last whichever direction is asked for, because they have no wait to order by.',
  })
  @Trim()
  @IsIn([...SUPPORT_SORTS])
  @IsOptional()
  declare sort?: SupportSort;
}

/**
 * A staff reply (§5.15).
 *
 * Extends the member's `SendMessageDto` rather than restating it, so a reply from the portal goes
 * through the same validation, the same `clientId` idempotency and the same attachment rules as a
 * message from the app — and a member reading the thread cannot tell which door it came through,
 * which is the point.
 */
export class SupportReplyDto extends SendMessageDto {
  @ApiPropertyOptional({
    description:
      'The canned reply this came from. Where `body` is omitted the stored text is sent verbatim; ' +
      'where both are given the body wins and this is recorded as provenance — a canned reply is ' +
      'a starting point, and an agent who edited it before sending still said their own words.',
  })
  @Trim()
  @IsString()
  @IsOptional()
  cannedReplyId?: string;

  @ApiPropertyOptional({
    description:
      '"I am not waiting on them." Keeps the thread `OPEN` and in the replier’s queue instead of ' +
      'moving it to `WAITING_ON_MEMBER`, for a note that does not ask the member anything.',
  })
  @Bool()
  @IsBoolean()
  @IsOptional()
  keepOpen?: boolean;
}

export class AssignSupportThreadDto {
  @ApiProperty({
    nullable: true,
    description:
      'The staff member to hand it to, or `null` to put it back in the unassigned queue. They ' +
      'must hold `support:manage` — or `guard:manage` for a Guard thread (B29) — because an ' +
      'assignee who cannot answer is a thread that looks handled and is not.',
  })
  @Trim()
  @IsString()
  @IsOptional()
  assigneeId: string | null;
}

/** The states a person can set by hand. The rest are what a message does (§7.6). */
export const SUPPORT_STATE_TARGETS = [
  SupportThreadState.OPEN,
  SupportThreadState.WAITING_ON_MEMBER,
  SupportThreadState.RESOLVED,
] as const;

export class PatchSupportThreadDto {
  @ApiPropertyOptional({
    enum: SUPPORT_STATE_TARGETS,
    description:
      'Allowed: `NEW → OPEN|RESOLVED`, `OPEN ↔ WAITING_ON_MEMBER`, anything `→ RESOLVED`, and ' +
      '`RESOLVED|CLOSED → OPEN` (which counts as a reopen). Anything else is a `409 ' +
      'INVALID_TRANSITION`. `CLOSED` is not settable: it is what seven days of silence after a ' +
      'resolution does.',
  })
  @IsIn([...SUPPORT_STATE_TARGETS])
  @IsOptional()
  state?: (typeof SUPPORT_STATE_TARGETS)[number];

  @ApiPropertyOptional({
    type: [String],
    description:
      'Replaces the whole list — send what the thread should end up with, not a change to it. ' +
      'Free text, lower-cased and de-duplicated here, because the alternative is three tags for ' +
      'one idea and a filter that finds a third of them.',
  })
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  @IsOptional()
  tags?: string[];
}

export class ListCannedRepliesDto {
  @ApiPropertyOptional({ description: 'Matches the title or the body.' })
  @Trim()
  @IsString()
  @MaxLength(120)
  @IsOptional()
  q?: string;

  @ApiPropertyOptional({
    description: 'Defaults to the active ones — the list the reply box offers.',
  })
  @Bool()
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class CreateCannedReplyDto {
  @ApiProperty({ maxLength: 80, description: 'What an agent picks it by.' })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  title: string;

  @ApiProperty({ maxLength: 4000, description: 'The message, as the member will read it.' })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body: string;
}

export class PatchCannedReplyDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @IsOptional()
  title?: string;

  @ApiPropertyOptional({ maxLength: 4000 })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  @IsOptional()
  body?: string;

  @ApiPropertyOptional({
    description:
      'Deactivated rather than deleted. A reply that has been sent a thousand times keeps its ' +
      'record and stops being offered.',
  })
  @Bool()
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
