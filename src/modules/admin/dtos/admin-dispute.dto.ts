import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  DealProblemState,
  DealTrack,
  DisputeOutcome,
  DisputeReason,
  DisputeState,
  DisputeSubjectType,
} from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  AdminPageOptionsDto,
  ApiErrorCode,
  ApiException,
  CsvArray,
  ReasonedDto,
  ToBoolean,
} from '@/common';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/** The states a dispute is still somebody's work. */
export const OPEN_DISPUTE_STATES: DisputeState[] = [DisputeState.OPEN, DisputeState.IN_REVIEW];

export class ListDisputesDto extends AdminPageOptionsDto {
  @ApiPropertyOptional({
    enum: DisputeState,
    isArray: true,
    description: 'CSV. Defaults to `OPEN,IN_REVIEW`.',
  })
  @CsvArray()
  @IsArray()
  @IsEnum(DisputeState, { each: true })
  @ArrayMaxSize(4)
  @IsOptional()
  state?: DisputeState[];

  @ApiPropertyOptional({ enum: DisputeReason, isArray: true, description: 'CSV.' })
  @CsvArray()
  @IsArray()
  @IsEnum(DisputeReason, { each: true })
  @ArrayMaxSize(5)
  @IsOptional()
  reasonCode?: DisputeReason[];

  @ApiPropertyOptional({ enum: DisputeSubjectType })
  @IsEnum(DisputeSubjectType)
  @IsOptional()
  subjectType?: DisputeSubjectType;

  @ApiPropertyOptional({ description: 'Whose work it is.' })
  @Trim()
  @IsUUID()
  @IsOptional()
  assignedToId?: string;

  @ApiPropertyOptional({ description: 'Nobody has picked it up yet.' })
  @ToBoolean()
  @IsBoolean()
  @IsOptional()
  unassigned?: boolean;

  @ApiPropertyOptional({
    description:
      'Past `expectedResolutionAt`. Narrows to the open states as well, because a decided ' +
      'dispute cannot be late any more — the same rule the report-case list applies.',
  })
  @ToBoolean()
  @IsBoolean()
  @IsOptional()
  overdue?: boolean;

  @ApiPropertyOptional({ description: 'Raised on or after this instant.' })
  @IsDateString()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({ description: 'Raised on or before this instant.' })
  @IsDateString()
  @IsOptional()
  to?: string;
}

export class UpdateDisputeDto {
  @ApiPropertyOptional({
    enum: [DisputeState.IN_REVIEW],
    description:
      'The only state this sets: `IN_REVIEW`, which is "somebody is looking". Ending a dispute ' +
      'goes through `resolve`, because an ending needs an outcome and a note for both parties.',
  })
  @IsEnum(DisputeState)
  @IsOptional()
  state?: DisputeState;

  @ApiPropertyOptional({ nullable: true, description: '`null` returns it to the unassigned pool.' })
  @Transform(({ value }) => (value === '' || value === null ? null : value))
  @IsUUID()
  @IsOptional()
  assigneeId?: string | null;

  @ApiPropertyOptional({
    description:
      'When both parties can expect an answer. Shown to them, so it is a commitment rather than ' +
      'an internal note — which is why it is settable rather than computed from an SLA.',
  })
  @IsDateString()
  @IsOptional()
  expectedResolutionAt?: string;

  assertSomething(): void {
    if (
      this.state === undefined &&
      this.assigneeId === undefined &&
      this.expectedResolutionAt === undefined
    ) {
      throw ApiException.badRequest(
        ApiErrorCode.VALIDATION_FAILED,
        'Send something to change: a state, an assignee, or when they can expect an answer.',
        { details: [{ field: 'state', message: 'At least one field is required.' }] },
      );
    }
  }
}

/**
 * §5.17's resolution.
 *
 * `Reasoned` as well as `resolutionNote`, and the two are not the same thing: the reason code is
 * the internal record of why staff acted, and the note is **shown to both parties**. Collapsing
 * them would mean either showing members a policy code or recording a sentence written for them as
 * the audit reason.
 */
export class ResolveDisputeDto extends ReasonedDto {
  @ApiProperty({ enum: DisputeOutcome })
  @IsEnum(DisputeOutcome)
  outcome: DisputeOutcome;

  @ApiProperty({
    maxLength: 2000,
    description:
      'Shown to **both** parties. Circl never moves money, so this is a finding and not a ' +
      'settlement — write it as something both of them can read.',
  })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  resolutionNote: string;
}

export class ListDealProblemsDto extends AdminPageOptionsDto {
  @ApiPropertyOptional({
    enum: DealProblemState,
    default: DealProblemState.OPEN,
    description: 'Defaults to `OPEN` — the flags nobody has settled yet.',
  })
  @IsEnum(DealProblemState)
  @IsOptional()
  problemState?: DealProblemState;

  @ApiPropertyOptional({ enum: DealTrack })
  @IsEnum(DealTrack)
  @IsOptional()
  track?: DealTrack;

  @ApiPropertyOptional({ description: 'Flagged on or after this instant.' })
  @IsDateString()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({ description: 'Flagged on or before this instant.' })
  @IsDateString()
  @IsOptional()
  to?: string;
}

export class ResolveDealProblemDto extends ReasonedDto {
  @ApiProperty({
    maxLength: 2000,
    description: 'Posted into the support thread of whoever raised the flag.',
  })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  resolutionNote: string;
}
