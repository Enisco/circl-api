import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BriefUrgency } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

/** Local, as in `booking.dto.ts`: the project has no shared one. */
const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/**
 * "Let Circl handle it": a member describing a problem in their own words.
 *
 * `description` is the only required field, and that is the feature rather than an oversight.
 * Somebody who could pick the right category would have browsed instead.
 */
export class CreateServiceRequestDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 4000,
    description: 'The problem, in the member’s own words.',
  })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  description: string;

  @ApiPropertyOptional({ enum: BriefUrgency, default: BriefUrgency.FLEXIBLE })
  @IsEnum(BriefUrgency)
  @IsOptional()
  urgency?: BriefUrgency;

  @ApiPropertyOptional({
    description:
      'Pence, display only. Send it only when the member typed a single figure; send ' +
      '`budgetText` instead for anything else.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  budget?: number;

  @ApiPropertyOptional({
    maxLength: 60,
    description:
      'What the member typed, when it was not a single figure — "50-100", "Flexible", ' +
      '"about £75". Shown to staff verbatim and parsed by nothing: "50-100" read as £50,100 is ' +
      'the bug this field exists to end.',
  })
  @Trim()
  @IsString()
  @MaxLength(60)
  @IsOptional()
  budgetText?: string;

  @ApiPropertyOptional({
    description:
      'The member’s own guess at the kind of help, from the profession taxonomy. Omitted means ' +
      'they do not know, which is allowed: it is never defaulted and never rejected.',
  })
  @Trim()
  @IsString()
  @IsOptional()
  categoryCode?: string;
}
