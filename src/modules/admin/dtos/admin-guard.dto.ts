import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GuardCaseSource, GuardThreadState, RiskLevel } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { AdminPageOptionsDto, CsvArray, ReasonedDto, ToBoolean } from '@/common';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/** The states a case sits in while somebody still has to do something about it. */
export const OPEN_GUARD_STATES: GuardThreadState[] = [
  GuardThreadState.OPEN,
  GuardThreadState.IN_PROGRESS,
];

export const GUARD_SORTS = ['risk', 'createdAt', 'updatedAt'] as const;

/**
 * §5.12's list query.
 *
 * `state` and `level` are CSV, replacing the single `state` and `minRiskLevel` this endpoint used
 * to take. Both old shapes still work: one value is a one-element list, and `minRiskLevel` is kept
 * because the member-facing Guard list sends it. `state=ALL` is kept for the same reason.
 */
export class ListGuardCasesDto extends AdminPageOptionsDto {
  @ApiPropertyOptional({
    enum: [...Object.values(GuardThreadState), 'ALL'],
    isArray: true,
    description: 'Comma-separated. Defaults to `OPEN,IN_PROGRESS`. `ALL` lifts the filter.',
  })
  @CsvArray()
  @IsIn([...Object.values(GuardThreadState), 'ALL'], { each: true })
  @IsOptional()
  state?: Array<GuardThreadState | 'ALL'>;

  @ApiPropertyOptional({
    enum: RiskLevel,
    isArray: true,
    description: 'Comma-separated, exact bands. For "at or above", use `minRiskLevel`.',
  })
  @CsvArray()
  @IsEnum(RiskLevel, { each: true })
  @IsOptional()
  level?: RiskLevel[];

  @ApiPropertyOptional({ enum: RiskLevel, description: 'At or above this band.' })
  @IsEnum(RiskLevel)
  @IsOptional()
  minRiskLevel?: RiskLevel;

  @ApiPropertyOptional({ enum: GuardCaseSource, isArray: true })
  @CsvArray()
  @IsEnum(GuardCaseSource, { each: true })
  @IsOptional()
  source?: GuardCaseSource[];

  @ApiPropertyOptional({ description: 'A GUARD_CATEGORY code.' })
  @Trim()
  @IsString()
  @IsOptional()
  category?: string;

  @ApiPropertyOptional({ description: 'Only cases I am assigned.' })
  @ToBoolean()
  @IsBoolean()
  @IsOptional()
  mine?: boolean;

  @ApiPropertyOptional({ description: 'Only cases assigned to this staff member.' })
  @Trim()
  @IsString()
  @IsOptional()
  assignedToId?: string;

  @ApiPropertyOptional({ description: 'Opened on or after this instant.' })
  @IsISO8601()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({ description: 'Opened before this instant.' })
  @IsISO8601()
  @IsOptional()
  to?: string;

  @ApiPropertyOptional({
    enum: GUARD_SORTS,
    default: 'risk',
    description: '`risk` is level desc then oldest first, which is the product promise.',
  })
  @IsIn([...GUARD_SORTS])
  @IsOptional()
  declare sort?: string;
}

/**
 * §5.12's patch.
 *
 * `note` is the field `ReasonedDto` already carries, and it does double duty here: it is the
 * reason the audit entry records *and* the body of an `InternalNote` against the case. One field
 * rather than two, because two fields called `note` and `reasonNote` on the same body is a
 * coin-flip at the call site, and the two would then disagree about why a case was closed.
 */
export class UpdateGuardCaseDto extends ReasonedDto {
  @ApiPropertyOptional({ enum: GuardThreadState })
  @IsEnum(GuardThreadState)
  @IsOptional()
  state?: GuardThreadState;

  @ApiPropertyOptional({
    description: 'A staff user id, or null to unassign. Must hold `guard:manage`.',
  })
  @IsOptional()
  @IsString()
  assignedToId?: string | null;
}

/** §5.12's manual escalation. */
export class CreateGuardCaseDto extends ReasonedDto {
  @ApiProperty({ description: 'The member the case is about.' })
  @IsUUID()
  memberId: string;

  @ApiProperty({ maxLength: 200 })
  @Trim()
  @IsString()
  @MaxLength(200)
  subject: string;

  @ApiPropertyOptional({ description: 'A GUARD_CATEGORY code.' })
  @Trim()
  @IsString()
  @IsOptional()
  categoryCode?: string;

  @ApiProperty({
    enum: ['CONTENT', 'REPORT_CASE', 'ESCALATION'],
    description: 'What is being escalated. `REPORT_CASE` records the case as REPORT-sourced.',
  })
  @IsIn(['CONTENT', 'REPORT_CASE', 'ESCALATION'])
  sourceType: 'CONTENT' | 'REPORT_CASE' | 'ESCALATION';

  @ApiProperty({ description: 'The id of whatever is being escalated.' })
  @Trim()
  @IsString()
  @MaxLength(200)
  sourceId: string;

  @ApiPropertyOptional({
    enum: RiskLevel,
    description:
      'Staff override. Omitted, the scan of the subject decides — and a staff escalation never ' +
      'lands below MEDIUM, because somebody chose to open it.',
  })
  @IsEnum(RiskLevel)
  @IsOptional()
  riskLevel?: RiskLevel;
}
