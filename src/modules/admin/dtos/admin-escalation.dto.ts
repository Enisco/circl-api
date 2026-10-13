import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EscalationState, ReportTargetType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AdminPageOptionsDto, CsvArray, ToBoolean } from '@/common';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
const Bool = ToBoolean;

/**
 * §5.10's five categories.
 *
 * A string union rather than a Prisma enum, and the column is a string too: this is a routing hint
 * Support picks from a list, not a state anything branches on. The one thing that reads it is the
 * priority of the report an escalation files, and that mapping lives beside the reasons it maps to
 * in `AdminEscalationService`. Adding a sixth category should not be a migration.
 */
export const ESCALATION_CATEGORIES = [
  'HARASSMENT',
  'SCAM',
  'SAFETY',
  'ENFORCEMENT_REQUEST',
  'OTHER',
] as const;

export type EscalationCategory = (typeof ESCALATION_CATEGORIES)[number];

/** The two states a reviewer can move an escalation to. `OPEN` is where it starts, not a decision. */
export const ESCALATION_OUTCOMES = [
  EscalationState.ACKNOWLEDGED,
  EscalationState.RESOLVED,
] as const;

export class CreateEscalationDto {
  @ApiProperty({ description: 'The member this is about.' })
  @Trim()
  @IsString()
  memberId: string;

  @ApiProperty({ enum: ESCALATION_CATEGORIES })
  @Trim()
  @IsIn([...ESCALATION_CATEGORIES])
  category: EscalationCategory;

  @ApiProperty({
    maxLength: 2000,
    description:
      'Why Trust & Safety are being asked to look. This is a colleague writing to a colleague, ' +
      'so it is the long field — the report filed alongside it carries the first 1,000 ' +
      'characters and this is the canonical copy.',
  })
  @Trim()
  @IsString()
  @MaxLength(2000)
  note: string;

  @ApiPropertyOptional({
    description: 'The support thread it came out of, where the member is being spoken to.',
  })
  @Trim()
  @IsString()
  @IsOptional()
  conversationId?: string;

  @ApiPropertyOptional({
    enum: ReportTargetType,
    description:
      'Send **both** `targetType` and `targetId`, or neither. With a target, a staff report is ' +
      'filed into that target’s case as well — so the content becomes work in the report queue ' +
      'rather than a description of work in a note. `SAFETY` and `SCAM` make that case urgent.',
  })
  @IsEnum(ReportTargetType)
  @IsOptional()
  targetType?: ReportTargetType;

  @ApiPropertyOptional({
    description: 'The content’s id, or an anonymous post’s `reportToken` (0.9, D2).',
  })
  @Trim()
  @IsString()
  @IsOptional()
  targetId?: string;
}

export class ListEscalationsDto extends AdminPageOptionsDto {
  @ApiPropertyOptional({
    description: 'Comma-separated states. Defaults to `OPEN,ACKNOWLEDGED` — the ones still open.',
  })
  @CsvArray()
  @IsEnum(EscalationState, { each: true })
  @IsOptional()
  state?: EscalationState[];

  @ApiPropertyOptional({ description: 'Escalations I raised.' })
  @Bool()
  @IsBoolean()
  @IsOptional()
  mine?: boolean;

  @ApiPropertyOptional({ description: 'Escalations about this member.' })
  @Trim()
  @IsString()
  @IsOptional()
  memberId?: string;
}

export class UpdateEscalationDto {
  @ApiProperty({
    enum: ESCALATION_OUTCOMES,
    description:
      '`OPEN → ACKNOWLEDGED` says somebody has it; `→ RESOLVED` closes it and is final. Moving ' +
      'to `OPEN`, or past `RESOLVED`, is a `409 INVALID_TRANSITION`.',
  })
  @IsIn([...ESCALATION_OUTCOMES])
  state: (typeof ESCALATION_OUTCOMES)[number];

  @ApiPropertyOptional({
    maxLength: 2000,
    description:
      'What was done about it, read by the person who raised it. Stored **only** with ' +
      '`RESOLVED`: a note on an acknowledgement would be an answer on something still open.',
  })
  @Trim()
  @IsString()
  @MaxLength(2000)
  @IsOptional()
  resolutionNote?: string;
}
