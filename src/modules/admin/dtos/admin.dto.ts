import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ModerationDecision,
  ModerationQueueState,
  ModerationQueueType,
  RiskLevel,
  TaxonomyKind,
} from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PageOptionsDto, ToBoolean } from '@/common';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
const Bool = ToBoolean;

export class ListQueueDto extends PageOptionsDto {
  @ApiPropertyOptional({ enum: ModerationQueueType })
  @IsEnum(ModerationQueueType)
  @IsOptional()
  type?: ModerationQueueType;

  @ApiPropertyOptional({ enum: ModerationQueueState, default: ModerationQueueState.PENDING })
  @IsEnum(ModerationQueueState)
  @IsOptional()
  state?: ModerationQueueState;

  @ApiPropertyOptional({ enum: RiskLevel, description: 'At or above this level.' })
  @IsEnum(RiskLevel)
  @IsOptional()
  minRiskLevel?: RiskLevel;

  @ApiPropertyOptional({ description: 'Only items assigned to me.' })
  @Bool()
  @IsBoolean()
  @IsOptional()
  mine?: boolean;
}

export class DecideQueueItemDto {
  @ApiProperty({ enum: ModerationDecision })
  @IsEnum(ModerationDecision)
  decision: ModerationDecision;

  @ApiPropertyOptional({
    maxLength: 1000,
    description:
      'Why. Recorded on an append-only action log — a safeguarding decision with no audit trail ' +
      'cannot be reviewed, and this queue makes decisions about people.',
  })
  @Trim()
  @IsString()
  @MaxLength(1000)
  @IsOptional()
  reason?: string;
}

export class ListGuardCasesDto extends PageOptionsDto {
  @ApiPropertyOptional({
    enum: ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'ALL'],
    default: 'OPEN',
  })
  @IsIn(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'ALL'])
  @IsOptional()
  state?: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED' | 'ALL';

  @ApiPropertyOptional({ enum: RiskLevel })
  @IsEnum(RiskLevel)
  @IsOptional()
  minRiskLevel?: RiskLevel;
}

export class UpdateGuardCaseDto {
  @ApiPropertyOptional({ enum: ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] })
  @IsIn(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'])
  @IsOptional()
  state?: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';

  @ApiPropertyOptional({ description: 'A staff user id, or null to unassign.' })
  @IsString()
  @IsOptional()
  assignedToId?: string | null;
}

export class UpsertTaxonomyTermDto {
  @ApiProperty({ enum: TaxonomyKind })
  @IsEnum(TaxonomyKind)
  kind: TaxonomyKind;

  @ApiProperty({ description: 'UPPER_SNAKE. Stable forever once shipped.' })
  @Trim()
  @IsString()
  @MaxLength(64)
  code: string;

  @ApiProperty({ description: 'The display label. Reword this freely; never rename the code.' })
  @Trim()
  @IsString()
  @MaxLength(120)
  label: string;

  @ApiPropertyOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  @IsOptional()
  description?: string;

  @ApiPropertyOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  sort?: number;

  @ApiPropertyOptional({
    description:
      'What turns a seeded-but-hidden term on without an app release. This is the whole reason the ' +
      'taxonomy endpoint exists (D1, D22).',
  })
  @Bool()
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiPropertyOptional({
    description: 'Per-kind extras: isRegulated, minPence, suggestedProfessionCodes.',
  })
  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;
}

export class ListRiskTermsDto extends PageOptionsDto {}

export class UpsertRiskTermDto {
  @ApiProperty({ description: 'A RiskCategory code.' })
  @Trim()
  @IsString()
  category: string;

  @ApiProperty({
    description: 'A lowercase phrase, matched on word boundaries.',
    maxLength: 120,
  })
  @Trim()
  @IsString()
  @MaxLength(120)
  pattern: string;

  @ApiPropertyOptional({
    default: 10,
    description: 'Additive. One unambiguous phrase should reach HIGH alone.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  weight?: number;

  @ApiPropertyOptional({ default: true })
  @Bool()
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiPropertyOptional({
    maxLength: 500,
    description: 'Why this phrase is here, for whoever inherits the lexicon.',
  })
  @Trim()
  @IsString()
  @MaxLength(500)
  @IsOptional()
  notes?: string;
}

/**
 * Retuning one term.
 *
 * **There is no `pattern` field, deliberately.** The global validation pipe runs with
 * `forbidNonWhitelisted`, so sending one is a 400 naming the field rather than a value silently
 * ignored. A phrase's hit count and false-positive rate are evidence about that exact phrase;
 * editing the words in place would hand one phrase's record to another, and that record is what
 * staff use to judge whether a term is worth keeping (§5.13 addendum).
 */
export class PatchRiskTermDto {
  @ApiPropertyOptional({ description: 'A RiskCategory code.' })
  @Trim()
  @IsString()
  @IsOptional()
  category?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  weight?: number;

  @ApiPropertyOptional()
  @Bool()
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiPropertyOptional({ maxLength: 500 })
  @Trim()
  @IsString()
  @MaxLength(500)
  @IsOptional()
  notes?: string;
}

export class SuspendUserDto {
  @ApiProperty({ description: 'ACTIVE restores, SUSPENDED blocks sign-in and every write.' })
  @IsIn(['ACTIVE', 'SUSPENDED'])
  status: 'ACTIVE' | 'SUSPENDED';

  @ApiPropertyOptional({ maxLength: 1000 })
  @Trim()
  @IsString()
  @MaxLength(1000)
  @IsOptional()
  reason?: string;
}
