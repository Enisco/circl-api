import { ApiPropertyOptional } from '@nestjs/swagger';
import { AdminReasonCode } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiErrorCode } from '../constants/api-error-code.constant';
import { ApiException } from '../exceptions/api.exception';

/** The reason codes, as a list, because `@IsIn` needs one and the enum is not one. */
const ADMIN_REASON_CODES = Object.values(AdminReasonCode);

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

  @ApiPropertyOptional({ description: "A field from the endpoint's own allowlist." })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  sort?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'] })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';

  @ApiPropertyOptional({
    description: 'Free text. Each endpoint documents which columns it searches.',
  })
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
   * Aliases, and the reason they have setters at all.
   *
   * These two are read-only views of `page` and `perPage` — but they are *declared properties*, so
   * `whitelist` does not strip them from a query string, and class-transformer assigned straight
   * onto the getter. `?size=100` on any admin list was a TypeError from inside the validation
   * pipe: a 500, with "which has only a getter" in the body, for a mistyped query parameter.
   *
   * Accepted as aliases rather than refused, so the caller gets the page they asked for. Coerced
   * because the `@Type(() => Number)` above is on the real field and never runs for these, and a
   * string `perPage` would then fail `@IsInt` with a message naming a parameter the caller did not
   * send. Everything else — the minimum, the maximum of 100, the depth limit — still applies,
   * because this only moves the value onto the field all of that is declared on.
   */
  set currentPage(value: number) {
    this.page = Number(value);
  }

  set size(value: number) {
    this.perPage = Number(value);
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
      throw ApiException.badRequest(
        ApiErrorCode.VALIDATION_FAILED,
        'That is not a sortable field.',
        {
          details: [{ field: 'sort', message: `One of: ${allowed.join(', ')}.` }],
        },
      );
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
 *
 * `reasonCode` is declared **optional and then demanded by `assertReasoned`**, which looks
 * backwards and is not. Left as a required field, an omitted reason is a 400 `VALIDATION_FAILED`
 * from the validation pipe, indistinguishable from a malformed body; the spec gives it its own 422
 * `REASON_REQUIRED` (§2.8) because it is a different thing — the request was well formed and the
 * rule it broke is a policy. The same method enforces the rule that `POLICY_VIOLATION` has to name
 * which policy, which no decorator can express at all.
 */
export class ReasonedDto {
  @ApiPropertyOptional({ enum: ADMIN_REASON_CODES })
  @IsOptional()
  @IsIn([...ADMIN_REASON_CODES])
  reasonCode?: AdminReasonCode;

  @ApiPropertyOptional({ description: 'Required when reasonCode is POLICY_VIOLATION.' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(40)
  policySubtype?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(2000)
  note?: string;

  /**
   * The reason, as the audit entry needs it — or a 422 saying what is missing.
   *
   * Returns the three fields together so a caller cannot take the code and forget the subtype:
   * "policy violation" with no rule named is the reason that looks recorded and explains nothing.
   */
  assertReasoned(): {
    reasonCode: AdminReasonCode;
    policySubtype: string | null;
    note: string | null;
  } {
    if (!this.reasonCode) {
      throw ApiException.unprocessable(
        ApiErrorCode.REASON_REQUIRED,
        'Say why. Every action a member can be affected by is recorded with its reason.',
        { details: [{ field: 'reasonCode', message: 'Required.' }] },
      );
    }

    if (this.reasonCode === AdminReasonCode.POLICY_VIOLATION && !this.policySubtype?.trim()) {
      throw ApiException.unprocessable(
        ApiErrorCode.REASON_REQUIRED,
        'Name the policy. "Policy violation" on its own is not a reason anybody can review.',
        { details: [{ field: 'policySubtype', message: 'Required for POLICY_VIOLATION.' }] },
      );
    }

    return {
      reasonCode: this.reasonCode,
      policySubtype: this.policySubtype?.trim() || null,
      note: this.note?.trim() || null,
    };
  }
}
