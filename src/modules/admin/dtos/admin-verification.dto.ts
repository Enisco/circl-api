import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AdminReasonCode, CategoryVerificationStatus } from '@prisma/client';
import {
  IsEnum,
  IsISO8601,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { AdminPageOptionsDto, CsvArray } from '@/common';

/** The same local helper the other admin DTOs use. */
const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/** The review queue's filters (v2 §12). */
export class ListVerificationsDto extends AdminPageOptionsDto {
  @ApiPropertyOptional({ enum: CategoryVerificationStatus, isArray: true })
  @CsvArray()
  @IsEnum(CategoryVerificationStatus, { each: true })
  @IsOptional()
  status?: CategoryVerificationStatus[];

  @ApiPropertyOptional({ description: 'A `PROFESSION` code.' })
  @IsString()
  @IsOptional()
  categoryCode?: string;

  @ApiPropertyOptional({ description: 'One professional, who may have several records.' })
  @IsString()
  @IsOptional()
  memberId?: string;
}

/** Approving or declining (v2 §12). */
export class DecideVerificationDto {
  @ApiProperty({ enum: ['APPROVE', 'REJECT'] })
  @IsIn(['APPROVE', 'REJECT'])
  decision: 'APPROVE' | 'REJECT';

  @ApiPropertyOptional({
    maxLength: 1000,
    description:
      'The reviewer’s words. **Reaches the member verbatim**, so it is written to them rather ' +
      'than about them. Required on a decline: it is the only thing that tells somebody what to fix.',
  })
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  @IsOptional()
  note?: string;

  @ApiPropertyOptional({
    maxLength: 200,
    description:
      'Which licence or registration was actually seen — "IAA level 2, F2024…". Staff-only, and ' +
      'the record that makes category-wide approval auditable (v2 §2.3): an IAA registration ' +
      'unlocks *Immigration solicitor* too, and this is what would make narrowing that a rule ' +
      'change rather than a data recovery.',
  })
  @Trim()
  @IsString()
  @MaxLength(200)
  @IsOptional()
  licenceSeen?: string;

  @ApiPropertyOptional({
    description:
      'When the approval lapses. **Omitting it changes nothing** — it does not clear a date set ' +
      'earlier, which is what `PATCH :id/expiry` with `null` is for. A date in the past is ' +
      'refused here exactly as it is there: it would suspend their services the moment it saved.',
  })
  @IsISO8601()
  @IsOptional()
  expiresAt?: string;

  @ApiPropertyOptional({ enum: AdminReasonCode })
  @IsEnum(AdminReasonCode)
  @IsOptional()
  reasonCode?: AdminReasonCode;
}

/** Withdrawing an approval. Every service in the category is suspended with it. */
export class RevokeVerificationDto {
  @ApiProperty({
    maxLength: 1000,
    description: 'Why. Reaches the member verbatim, and their services go down — so it has to say.',
  })
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  note: string;

  @ApiPropertyOptional({ enum: AdminReasonCode })
  @IsEnum(AdminReasonCode)
  @IsOptional()
  reasonCode?: AdminReasonCode;
}

/**
 * Setting or clearing the expiry.
 *
 * `null` clears it, which is a different answer from omitting the field: one says "this does not
 * lapse" and the other says nothing at all.
 */
export class SetVerificationExpiryDto {
  @ApiProperty({ nullable: true, description: 'ISO date, or null to clear.' })
  @IsISO8601()
  @IsOptional()
  expiresAt?: string | null;
}
