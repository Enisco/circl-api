import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AdminReasonCode, ThreadAccessLinkType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/**
 * §5.6's grant request.
 *
 * The shape is the policy: a reason **code**, a record type and that record's id. There is
 * deliberately no free-text reason field — S9.1 says free-text references are never accepted, and
 * the reason is that "investigating a complaint" cannot be checked by anybody afterwards, whereas
 * "report case 7f3a" can be opened. `note` exists beside the link for the sentence a staff member
 * wants to leave for the next reader, and it is never a substitute for the link.
 */
export class GrantThreadAccessDto {
  @ApiProperty({
    enum: AdminReasonCode,
    description:
      'Why this thread is being read. The same vocabulary every other staff action uses.',
  })
  @IsEnum(AdminReasonCode)
  reasonCode: AdminReasonCode;

  @ApiProperty({
    enum: ThreadAccessLinkType,
    description:
      'What is being worked on. The record must exist, be one the caller can already see under ' +
      'their own permissions, and involve somebody in the conversation — otherwise 422 ' +
      '`LINK_REQUIRED`.',
  })
  @IsEnum(ThreadAccessLinkType)
  linkedType: ThreadAccessLinkType;

  @ApiProperty({
    description:
      'The record’s id. For `SUPPORT_THREAD` that is the **conversation** id, which is how §5.15 ' +
      'addresses a support thread.',
  })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  linkedId: string;

  @ApiPropertyOptional({ maxLength: 1000, description: 'A sentence for whoever reads this later.' })
  @Trim()
  @IsString()
  @MaxLength(1000)
  @IsOptional()
  note?: string;
}
