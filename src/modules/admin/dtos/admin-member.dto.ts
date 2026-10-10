import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsIn, IsOptional, IsUUID } from 'class-validator';
import { CsvArray, ReasonedDto } from '@/common';

export const REVEALABLE_FIELDS = ['email', 'phone', 'dateOfBirth', 'ip'] as const;
export type RevealableField = (typeof REVEALABLE_FIELDS)[number];

/**
 * A request to see a member's actual contact details (S8.2).
 *
 * The reason code is mandatory, as it is on every action: a reveal is not a read, it is a decision
 * to look, and the entry it writes has to say what the looking was for. The fields are asked for
 * one at a time — a staff member confirming a phone number over a support call does not need the
 * email address, and the audit entry records exactly what was uncovered.
 */
export class RevealMemberDto extends ReasonedDto {
  @ApiProperty({ enum: REVEALABLE_FIELDS, isArray: true })
  @CsvArray()
  @IsArray()
  @ArrayMinSize(1)
  @IsIn(REVEALABLE_FIELDS as unknown as string[], { each: true })
  fields: RevealableField[];

  @ApiPropertyOptional({
    description: 'One session, for `ip`. Omit for the last fifty sessions.',
  })
  @IsOptional()
  @IsUUID()
  sessionId?: string;
}
