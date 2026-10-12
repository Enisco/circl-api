import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ListingReviewState } from '@prisma/client';
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
  Matches,
} from 'class-validator';
import { AdminPageOptionsDto, CsvArray, ReasonedDto, ToBoolean } from '@/common';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/** §2.9: the two answers a reviewer can give. */
export const REVIEW_OUTCOMES = [ListingReviewState.APPROVED, ListingReviewState.REJECTED] as const;

export class ListListingReviewsDto extends AdminPageOptionsDto {
  @ApiPropertyOptional({
    description: 'Comma-separated states. Defaults to `PENDING`.',
    enum: ListingReviewState,
    isArray: true,
  })
  @CsvArray()
  @IsEnum(ListingReviewState, { each: true })
  @IsOptional()
  state?: ListingReviewState[];

  @ApiPropertyOptional({ description: 'One gated profession code, e.g. `IMMIGRATION`.' })
  @Trim()
  @IsString()
  @IsOptional()
  categoryCode?: string;

  @ApiPropertyOptional({ description: 'Only the ones I have claimed.' })
  @ToBoolean()
  @IsBoolean()
  @IsOptional()
  mine?: boolean;
}

export class DecideListingReviewDto extends ReasonedDto {
  @ApiProperty({
    enum: REVIEW_OUTCOMES,
    description:
      '`APPROVED` publishes the listing. `REJECTED` leaves it unpublished and tells the member ' +
      'what to change; any edit afterwards sends it back to this queue.',
  })
  @IsIn([...REVIEW_OUTCOMES])
  outcome: (typeof REVIEW_OUTCOMES)[number];

  @ApiPropertyOptional({
    maxLength: 1000,
    description:
      'Shown to the member verbatim. Required on a decline — "not approved" with no reason is ' +
      'not something anybody can act on, and the member is being told they may not work.',
  })
  @Trim()
  @IsString()
  @MaxLength(1000)
  @IsOptional()
  memberMessage?: string;
}

/**
 * §2.9: which professions hold their listings until a human approves them.
 *
 * The **whole set**, not a toggle. Two reasons. A toggle raced with another toggle leaves the set
 * in a state neither person chose, and this one has consequences attached — listings get queued or
 * released by the write — so "what the set is now" is the only safe thing to send. It also makes
 * the request idempotent, which matters because it carries an `Idempotency-Key`.
 */
export class SetGatedProfessionsDto extends ReasonedDto {
  @ApiProperty({
    isArray: true,
    type: String,
    description:
      'Every `PROFESSION` code that should require approval, as the complete list. Send `[]` to ' +
      'switch approval off entirely — which releases every listing currently waiting.',
    example: ['IMMIGRATION', 'LEGAL', 'FINANCE_ACCOUNTING'],
  })
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @Matches(/^[A-Z][A-Z0-9_]*$/, { each: true, message: 'Codes are UPPER_SNAKE.' })
  codes: string[];
}
