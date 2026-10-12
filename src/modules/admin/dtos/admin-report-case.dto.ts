import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  ModerationDecision,
  ReportCasePriority,
  ReportCaseState,
  ReportReason,
  ReportTargetType,
  RiskLevel,
} from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { AdminPageOptionsDto, CsvArray, ReasonedDto, ToBoolean } from '@/common';
import { GuardInputDto } from './admin-queue.dto';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
const Bool = ToBoolean;

/** The decisions a report case can be closed with (§5.10, `CaseDecision`). */
export const CASE_DECISIONS = [
  ModerationDecision.NO_ACTION,
  ModerationDecision.REMOVE_CONTENT,
  ModerationDecision.WARN_AUTHOR,
  ModerationDecision.SUSPEND_AUTHOR,
  ModerationDecision.ESCALATE_GUARD,
  ModerationDecision.REMOVE_AND_WARN,
  ModerationDecision.REMOVE_AND_SUSPEND,
] as const;

/** The durations §5.10 offers, which are the ones `POST members/:id/suspend` already takes. */
export const SUSPENSION_DURATIONS = ['24h', '7d', '30d', 'permanent', 'custom'] as const;

export class ListReportCasesDto extends AdminPageOptionsDto {
  @ApiPropertyOptional({
    description:
      'Comma-separated states. Defaults to `OPEN,IN_REVIEW` — the work still to do, which is ' +
      'what the screen is for.',
    example: 'OPEN,IN_REVIEW',
  })
  @CsvArray()
  @IsEnum(ReportCaseState, { each: true })
  @IsOptional()
  state?: ReportCaseState[];

  @ApiPropertyOptional({ description: 'Comma-separated priorities.', example: 'URGENT,HIGH' })
  @CsvArray()
  @IsEnum(ReportCasePriority, { each: true })
  @IsOptional()
  priority?: ReportCasePriority[];

  @ApiPropertyOptional({ description: 'Comma-separated reasons; matches a case with any of them.' })
  @CsvArray()
  @IsEnum(ReportReason, { each: true })
  @IsOptional()
  reasonCodes?: ReportReason[];

  @ApiPropertyOptional({ description: 'Comma-separated target types.' })
  @CsvArray()
  @IsEnum(ReportTargetType, { each: true })
  @IsOptional()
  targetType?: ReportTargetType[];

  @ApiPropertyOptional({ description: 'Comma-separated risk levels.' })
  @CsvArray()
  @IsEnum(RiskLevel, { each: true })
  @IsOptional()
  riskLevel?: RiskLevel[];

  @ApiPropertyOptional({ description: 'Cases assigned to this staff member.' })
  @Trim()
  @IsString()
  @IsOptional()
  assignedToId?: string;

  @ApiPropertyOptional({ description: 'Only the cases I am working on.' })
  @Bool()
  @IsBoolean()
  @IsOptional()
  mine?: boolean;

  @ApiPropertyOptional({ description: 'Only cases nobody has claimed.' })
  @Bool()
  @IsBoolean()
  @IsOptional()
  unassigned?: boolean;

  @ApiPropertyOptional({ description: 'Only cases past their SLA.' })
  @Bool()
  @IsBoolean()
  @IsOptional()
  overdue?: boolean;

  @ApiPropertyOptional({
    description: 'The **reported** member. Cases this member filed are `reporterId`.',
  })
  @Trim()
  @IsString()
  @IsOptional()
  memberId?: string;

  @ApiPropertyOptional({ description: 'Cases containing a report filed by this member.' })
  @Trim()
  @IsString()
  @IsOptional()
  reporterId?: string;

  @ApiPropertyOptional({ description: 'First reported on or after this instant.' })
  @IsISO8601()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({ description: 'First reported on or before this instant.' })
  @IsISO8601()
  @IsOptional()
  to?: string;

  @ApiPropertyOptional({
    enum: ['priority', 'dueAt', 'reportCount', 'lastReportedAt', 'createdAt'],
    description:
      'Default depends on what is being listed: open work sorts by priority then `dueAt` (the ' +
      'next thing to do first), and a list of decided cases sorts by `createdAt` desc, because ' +
      'the most recent decision is the one being looked up.',
  })
  @IsIn(['priority', 'dueAt', 'reportCount', 'lastReportedAt', 'createdAt'])
  @IsOptional()
  declare sort?: 'priority' | 'dueAt' | 'reportCount' | 'lastReportedAt' | 'createdAt';
}

export class ListReportsDto extends AdminPageOptionsDto {
  @ApiPropertyOptional({ description: 'Comma-separated reasons.' })
  @CsvArray()
  @IsEnum(ReportReason, { each: true })
  @IsOptional()
  reasonCodes?: ReportReason[];

  @ApiPropertyOptional({ description: 'Comma-separated target types.' })
  @CsvArray()
  @IsEnum(ReportTargetType, { each: true })
  @IsOptional()
  targetType?: ReportTargetType[];

  @ApiPropertyOptional({ description: 'Report state.' })
  @Trim()
  @IsIn(['RECEIVED', 'TRIAGED', 'ACTIONED', 'DISMISSED'])
  @IsOptional()
  state?: 'RECEIVED' | 'TRIAGED' | 'ACTIONED' | 'DISMISSED';

  @ApiPropertyOptional({ description: 'Filed by this member.' })
  @Trim()
  @IsString()
  @IsOptional()
  reporterId?: string;

  @ApiPropertyOptional({ description: 'Filed on or after this instant.' })
  @IsISO8601()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({ description: 'Filed on or before this instant.' })
  @IsISO8601()
  @IsOptional()
  to?: string;
}

export class AssignCaseDto extends ReasonedDto {
  @ApiProperty({
    nullable: true,
    description:
      'The staff member to hand it to, or `null` to leave it unassigned. They must be able to ' +
      'decide cases — assigning work to somebody who cannot act on it is a case that stalls.',
  })
  @Trim()
  @IsString()
  @IsOptional()
  assigneeId?: string | null;
}

export class SuspensionLengthDto {
  @ApiProperty({ enum: SUSPENSION_DURATIONS })
  @IsIn([...SUSPENSION_DURATIONS])
  duration: (typeof SUSPENSION_DURATIONS)[number];

  @ApiPropertyOptional({ description: 'Required when `duration` is `custom`.' })
  @IsISO8601()
  @IsOptional()
  until?: string;
}

export class CaseDecisionDto extends ReasonedDto {
  @ApiProperty({ enum: CASE_DECISIONS })
  @IsIn([...CASE_DECISIONS])
  decision: (typeof CASE_DECISIONS)[number];

  @ApiPropertyOptional({
    type: SuspensionLengthDto,
    description: 'How long, for the two decisions that suspend. Defaults to 7 days if omitted.',
  })
  @IsOptional()
  suspension?: SuspensionLengthDto;

  @ApiPropertyOptional({
    maxLength: 500,
    description: 'Shown to the author verbatim, with the warning or the suspension notice.',
  })
  @Trim()
  @IsString()
  @MaxLength(500)
  @IsOptional()
  memberMessage?: string;

  @ApiPropertyOptional({
    default: true,
    description:
      'Tell the people who reported it. Default true: a report with no answer is why §9 lists ' +
      'the lost-report bug. Turn it off only where telling them would identify somebody.',
  })
  @Bool()
  @IsBoolean()
  @IsOptional()
  notifyReporters?: boolean;

  @ApiPropertyOptional({
    default: true,
    description:
      'Whether the author collects a strike. Default true for every decision that removes, ' +
      'warns or suspends; ignored by `NO_ACTION` and `ESCALATE_GUARD`.',
  })
  @Bool()
  @IsBoolean()
  @IsOptional()
  issueStrike?: boolean;

  @ApiPropertyOptional({
    type: GuardInputDto,
    description:
      'For `ESCALATE_GUARD`: the Guard category and an opening note for the safeguarding thread. ' +
      'The same shape the queue takes, so a reviewer escalating from either place sends the same body.',
  })
  @ValidateNested()
  @Type(() => GuardInputDto)
  @IsOptional()
  guard?: GuardInputDto;
}
