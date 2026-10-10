import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiErrorCode } from '../constants/api-error-code.constant';
import { ApiException } from '../exceptions/api.exception';

/** Beyond this, `OFFSET` stops being cheap and the answer stops being useful. */
const MAX_DEPTH = 10_000;

/**
 * Paging for admin lists.
 *
 * Separate from the member `PageOptionsDto`, which reads `limit` with a maximum of 50: a staff
 * member working a queue wants a hundred rows, and a member scrolling a feed does not. Values
 * above the maximum are **rejected**, not clamped, because a client asking for 500 has a bug and
 * silently giving it 100 hides the bug behind a page that looks short.
 */
export class AdminPageOptionsDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  perPage?: number = 25;

  @ApiPropertyOptional({ description: 'A field from the endpoint\'s own allowlist.' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  sort?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'] })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';

  @ApiPropertyOptional({ description: 'Free text. Each endpoint documents which columns it searches.' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  q?: string;

  get currentPage(): number {
    return this.page ?? 1;
  }

  get size(): number {
    return this.perPage ?? 25;
  }

  /**
   * Refuses a page so deep that the database would scan everything before it.
   *
   * Told to narrow the filters rather than handed an empty page, because an empty page looks like
   * "no results" and the real answer is "ask a better question".
   */
  assertDepth(): void {
    if (this.currentPage * this.size > MAX_DEPTH) {
      throw ApiException.badRequest(
        ApiErrorCode.PAGE_TOO_DEEP,
        'That page is too far in. Narrow the filters instead.',
      );
    }
  }

  /** Maps `sort` onto a field the endpoint allows, falling back rather than failing silently. */
  sortField<T extends string>(allowed: readonly T[], fallback: T): T {
    if (!this.sort) return fallback;

    if (!(allowed as readonly string[]).includes(this.sort)) {
      throw ApiException.badRequest(ApiErrorCode.VALIDATION_FAILED, 'That is not a sortable field.', {
        details: [{ field: 'sort', message: `One of: ${allowed.join(', ')}.` }],
      });
    }

    return this.sort as T;
  }
}

/**
 * The reason mixin, on every enforcement, edit and destructive action.
 *
 * An audit trail that records what happened and not why is a list of events, not an account of
 * decisions — and the person who has to answer for a decision six months later is rarely the one
 * who made it.
 */
export class ReasonedDto {
  @ApiPropertyOptional({
    enum: [
      'MEMBER_REQUEST',
      'CORRECTION',
      'POLICY_VIOLATION',
      'SAFETY_CONCERN',
      'SCAM_FRAUD',
      'LEGAL_GDPR',
      'OTHER',
    ],
  })
  @IsIn([
    'MEMBER_REQUEST',
    'CORRECTION',
    'POLICY_VIOLATION',
    'SAFETY_CONCERN',
    'SCAM_FRAUD',
    'LEGAL_GDPR',
    'OTHER',
  ])
  reasonCode: string;

  @ApiPropertyOptional({ description: 'Required when reasonCode is POLICY_VIOLATION.' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  policySubtype?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(2000)
  note?: string;
}
