import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ContentRiskTier,
  ModerationDecision,
  ModerationQueueState,
  ModerationQueueType,
  ReportCasePriority,
  ReportTargetType,
  RiskLevel,
} from '@prisma/client';
import { Transform, Type } from 'class-transformer';
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
import { AdminPageOptionsDto, CsvArray, ReasonedDto, ToBoolean } from '@/common';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/**
 * §5.9's queue, as the portal actually works it.
 *
 * The old `ListQueueDto` took one `type` and one `state`. A reviewer working tabs needs several of
 * each — "everything open in flagged content and anonymous posts" is one request, not two — so
 * every list filter here is a CSV, which is the convention the rest of the admin surface already
 * uses (`CsvArray`).
 */

/**
 * The default tabs, when no `type` is given.
 *
 * `REPORTED_CONTENT` is deliberately absent: those items live at `reports/cases`, which has its own
 * screen, its own decision shape and its own permissions. Returning them here would show the same
 * work in two places and invite a reviewer to decide it in the one that cannot. The count is still
 * reported in `meta.countsByType`, so the portal can badge the tab it belongs to.
 *
 * `MANAGED_REQUEST` is retired (B15) and `PROFESSIONAL_REVIEW` has its own queue (§2.9).
 */
export const DEFAULT_QUEUE_TYPES: ModerationQueueType[] = [
  ModerationQueueType.FLAGGED_CONTENT,
  ModerationQueueType.ANONYMOUS_POST,
  ModerationQueueType.AUTO_GUIDE,
  ModerationQueueType.GUARD_RISK,
  ModerationQueueType.APPEAL,
];

/** The states an item is still work in. */
export const OPEN_QUEUE_STATES: ModerationQueueState[] = [
  ModerationQueueState.PENDING,
  ModerationQueueState.IN_REVIEW,
];

export const QUEUE_SORTS = ['priority', 'dueAt', 'createdAt'] as const;

export class ListQueueItemsDto extends AdminPageOptionsDto {
  @ApiPropertyOptional({
    enum: ModerationQueueType,
    isArray: true,
    description: `Comma-separated. Defaults to ${DEFAULT_QUEUE_TYPES.join(', ')}.`,
  })
  @CsvArray()
  @IsEnum(ModerationQueueType, { each: true })
  @IsOptional()
  type?: ModerationQueueType[];

  @ApiPropertyOptional({
    enum: ModerationQueueState,
    isArray: true,
    description: 'Comma-separated. Defaults to `PENDING,IN_REVIEW`.',
  })
  @CsvArray()
  @IsEnum(ModerationQueueState, { each: true })
  @IsOptional()
  state?: ModerationQueueState[];

  @ApiPropertyOptional({ enum: ReportCasePriority, isArray: true })
  @CsvArray()
  @IsEnum(ReportCasePriority, { each: true })
  @IsOptional()
  priority?: ReportCasePriority[];

  @ApiPropertyOptional({
    enum: ContentRiskTier,
    isArray: true,
    description: "The scan's tier, read from the content's safety row.",
  })
  @CsvArray()
  @IsEnum(ContentRiskTier, { each: true })
  @IsOptional()
  tier?: ContentRiskTier[];

  @ApiPropertyOptional({ enum: RiskLevel, description: 'At or above this band.' })
  @IsEnum(RiskLevel)
  @IsOptional()
  minRiskLevel?: RiskLevel;

  @ApiPropertyOptional({ enum: ReportTargetType, isArray: true })
  @CsvArray()
  @IsEnum(ReportTargetType, { each: true })
  @IsOptional()
  targetType?: ReportTargetType[];

  @ApiPropertyOptional({ description: 'Only items I have claimed.' })
  @ToBoolean()
  @IsBoolean()
  @IsOptional()
  mine?: boolean;

  @ApiPropertyOptional({ description: 'Only items claimed by this staff member.' })
  @Trim()
  @IsString()
  @IsOptional()
  assignedToId?: string;

  @ApiPropertyOptional({ description: 'Only items nobody has claimed.' })
  @ToBoolean()
  @IsBoolean()
  @IsOptional()
  unassigned?: boolean;

  @ApiPropertyOptional({ description: 'Only items past their deadline.' })
  @ToBoolean()
  @IsBoolean()
  @IsOptional()
  overdue?: boolean;

  @ApiPropertyOptional({
    enum: QUEUE_SORTS,
    default: 'priority',
    description:
      '`priority` is band, then closest to breaching, then oldest — the order a reviewer should ' +
      'work in. The other two are for reading the queue rather than working it.',
  })
  @IsIn([...QUEUE_SORTS])
  @IsOptional()
  declare sort?: (typeof QUEUE_SORTS)[number];
}

export class SuspensionInputDto {
  @ApiProperty({ enum: ['24h', '7d', '30d', 'permanent', 'custom'] })
  @IsIn(['24h', '7d', '30d', 'permanent', 'custom'])
  duration: '24h' | '7d' | '30d' | 'permanent' | 'custom';

  @ApiPropertyOptional({ description: 'Required when `duration` is `custom`.' })
  @IsISO8601()
  @IsOptional()
  until?: string;
}

export class GuardInputDto {
  @ApiPropertyOptional()
  @Trim()
  @IsString()
  @IsOptional()
  categoryCode?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @Trim()
  @IsString()
  @MaxLength(2000)
  @IsOptional()
  note?: string;
}

/** §5.9's `DecideInput`. */
export class DecideQueueDto extends ReasonedDto {
  @ApiProperty({
    enum: ModerationDecision,
    description:
      'Must be one of the item’s `allowedDecisions`, which depend on its type, its target and the ' +
      'content’s current visibility. Anything else is 422 `INVALID_DECISION` — the list is on the ' +
      'item for exactly this reason, so the portal never has to guess.',
  })
  @IsEnum(ModerationDecision)
  decision: ModerationDecision;

  @ApiPropertyOptional({
    maxLength: 500,
    description:
      'Shown to the author, verbatim. **Required** when rejecting an anonymous post (422 ' +
      '`MEMBER_MESSAGE_REQUIRED`): a rejection with no reason is something the author can neither ' +
      'fix nor argue with.',
  })
  @Trim()
  @IsString()
  @MaxLength(500)
  @IsOptional()
  memberMessage?: string;

  @ApiPropertyOptional({
    description:
      'For the removal and warning decisions. Defaults to **true** (§6.9): the decisions that name ' +
      'a strike issue one. `false` warns without one, which is the "quiet word" a first offence ' +
      'sometimes deserves.',
  })
  @ToBoolean()
  @IsBoolean()
  @IsOptional()
  issueStrike?: boolean;

  @ApiPropertyOptional({
    description: 'For the suspending decisions. Required when the decision suspends.',
    type: 'object',
    additionalProperties: false,
    properties: {
      duration: { type: 'string', enum: ['24h', '7d', '30d', 'permanent', 'custom'] },
      until: { type: 'string', format: 'date-time' },
    },
  })
  // `@ValidateNested` **and** `@Type`, not `@IsOptional` alone. Without both, class-validator
  // treats the object as opaque: every rule on `SuspensionInputDto` is declared and none of them
  // runs, so `{ duration: 'forever' }` reaches the service and a suspension is issued off a
  // duration nothing recognised.
  @ValidateNested()
  @Type(() => SuspensionInputDto)
  @IsOptional()
  suspension?: SuspensionInputDto;

  @ApiPropertyOptional({
    description: 'For `ESCALATE_GUARD`: the Guard category and a note for the safeguarding thread.',
    type: 'object',
    additionalProperties: false,
    properties: {
      categoryCode: { type: 'string' },
      note: { type: 'string' },
    },
  })
  @ValidateNested()
  @Type(() => GuardInputDto)
  @IsOptional()
  guard?: GuardInputDto;
}

/** §5.9's assign. `null` unassigns, which is why it is not simply omitted. */
export class AssignQueueItemDto {
  @ApiProperty({
    nullable: true,
    description: 'The staff member to give it to, or `null` to return it to the unassigned pool.',
  })
  @Trim()
  @IsString()
  @IsOptional()
  assigneeId?: string | null;
}
