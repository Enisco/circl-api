import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  BriefState,
  BriefUrgency,
  ManagedRequestClosedReason,
  ManagedRequestState,
  ManagedRequestSubject,
} from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AdminPageOptionsDto, ApiErrorCode, ApiException, CsvArray, ToBoolean } from '@/common';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/** The states a managed request is still somebody's work. */
export const OPEN_MANAGED_STATES: ManagedRequestState[] = [
  ManagedRequestState.OPEN,
  ManagedRequestState.IN_PROGRESS,
];

export class ListManagedRequestsDto extends AdminPageOptionsDto {
  @ApiPropertyOptional({
    enum: ManagedRequestState,
    isArray: true,
    description: 'CSV. Defaults to the two open states — the pipeline, not its history.',
  })
  @CsvArray()
  @IsArray()
  @IsEnum(ManagedRequestState, { each: true })
  @ArrayMaxSize(3)
  @IsOptional()
  state?: ManagedRequestState[];

  @ApiPropertyOptional({ enum: ManagedRequestSubject })
  @IsEnum(ManagedRequestSubject)
  @IsOptional()
  subjectType?: ManagedRequestSubject;

  @ApiPropertyOptional({ description: 'Whose work. `mine` is this filter with your own id.' })
  @Trim()
  @IsUUID()
  @IsOptional()
  assignedToId?: string;

  @ApiPropertyOptional({ description: 'Nobody has picked it up yet.' })
  @ToBoolean()
  @IsBoolean()
  @IsOptional()
  unassigned?: boolean;

  @ApiPropertyOptional({ isArray: true, description: 'CSV of city ids — the member’s city.' })
  @CsvArray()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  @IsOptional()
  cityIds?: string[];

  @ApiPropertyOptional({ description: 'Raised on or after this instant.' })
  @IsDateString()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({ description: 'Raised on or before this instant.' })
  @IsDateString()
  @IsOptional()
  to?: string;
}

/**
 * §5.16's update. Every field optional, and a body that changes nothing is a 400 rather than a
 * no-op — unlike a Guard case, where `PATCH` with nothing is how the portal saves a form it has
 * not touched. This endpoint is reached by pressing a button, so an empty one is a bug worth
 * seeing.
 */
export class UpdateManagedRequestDto {
  @ApiPropertyOptional({
    enum: [ManagedRequestState.OPEN, ManagedRequestState.IN_PROGRESS, ManagedRequestState.CLOSED],
  })
  @IsEnum(ManagedRequestState)
  @IsOptional()
  state?: ManagedRequestState;

  @ApiPropertyOptional({
    nullable: true,
    description:
      '`null` returns it to the unassigned pool. The assignee must hold `managed:manage`.',
  })
  @Transform(({ value }) => (value === '' || value === null ? null : value))
  @IsUUID()
  @IsOptional()
  assigneeId?: string | null;

  @ApiPropertyOptional({
    enum: ManagedRequestClosedReason,
    description: 'Required to close (§7.7): a closed request with no reason cannot be reported on.',
  })
  @IsEnum(ManagedRequestClosedReason)
  @IsOptional()
  closedReason?: ManagedRequestClosedReason;

  @ApiPropertyOptional({
    maxLength: 2000,
    description:
      'Appended to the request’s own notes, with the date and who wrote it — the pipeline’s ' +
      'running record. It is **not** shown to the member; the system message in their thread is.',
  })
  @Trim()
  @IsString()
  @MaxLength(2000)
  @IsOptional()
  note?: string;

  /** At least one field, so a `PATCH` that does nothing is caught here rather than audited. */
  assertSomething(): void {
    const touched =
      this.state !== undefined ||
      this.assigneeId !== undefined ||
      this.closedReason !== undefined ||
      (this.note ?? '').length > 0;

    if (!touched) {
      throw ApiException.badRequest(
        ApiErrorCode.VALIDATION_FAILED,
        'Send something to change: a state, an assignee, a closing reason or a note.',
        { details: [{ field: 'state', message: 'At least one field is required.' }] },
      );
    }
  }
}

/** The sorts the brief list offers. An allowlist, so `sort` cannot name a column. */
export const BRIEF_SORTS = ['createdAt', 'urgency'] as const;
export type BriefSort = (typeof BRIEF_SORTS)[number];

export class ListBriefsDto extends AdminPageOptionsDto {
  @ApiPropertyOptional({ enum: BriefState, isArray: true, description: 'CSV.' })
  @CsvArray()
  @IsArray()
  @IsEnum(BriefState, { each: true })
  @ArrayMaxSize(6)
  @IsOptional()
  state?: BriefState[];

  @ApiPropertyOptional({ enum: BriefUrgency, isArray: true, description: 'CSV.' })
  @CsvArray()
  @IsArray()
  @IsEnum(BriefUrgency, { each: true })
  @ArrayMaxSize(5)
  @IsOptional()
  urgency?: BriefUrgency[];

  @ApiPropertyOptional({ isArray: true, description: 'CSV of profession category codes.' })
  @CsvArray()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  @IsOptional()
  categories?: string[];

  @ApiPropertyOptional({ isArray: true, description: 'CSV of city ids.' })
  @CsvArray()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  @IsOptional()
  cityIds?: string[];

  @ApiPropertyOptional({ description: 'Raised on or after this instant.' })
  @IsDateString()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({ description: 'Raised on or before this instant.' })
  @IsDateString()
  @IsOptional()
  to?: string;

  @ApiPropertyOptional({
    enum: BRIEF_SORTS,
    default: 'createdAt',
    description:
      '`urgency` sorts most urgent first — on the enum’s own order, not alphabetically, because ' +
      '`ASAP` sorting above `FLEXIBLE` by accident is not a guarantee worth relying on.',
  })
  @Trim()
  @IsIn([...BRIEF_SORTS])
  @IsOptional()
  declare sort?: BriefSort;
}

export class PlaceBriefDto {
  @ApiProperty({ description: 'The listing to place them with. Must be live and taking work.' })
  @Trim()
  @IsUUID()
  listingId: string;

  @ApiPropertyOptional({ maxLength: 2000, description: 'For the pipeline’s record.' })
  @Trim()
  @IsString()
  @MaxLength(2000)
  @IsOptional()
  note?: string;
}

export class UpdateBriefDto {
  @ApiProperty({
    enum: [BriefState.OPEN, BriefState.MATCHED, BriefState.CLOSED],
    description:
      '`OPEN → MATCHED`, anything `→ CLOSED`, and `PLACED → OPEN` to place it again — which ' +
      'needs `moderation:assign` (§7.7). Anything else is 409 `INVALID_TRANSITION`.',
  })
  @IsEnum(BriefState)
  state: BriefState;

  @ApiPropertyOptional({ maxLength: 2000 })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  @IsOptional()
  note?: string;
}
