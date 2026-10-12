import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AppealState, AppealSubjectType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AdminPageOptionsDto, CsvArray, ReasonedDto, ToBoolean } from '@/common';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
const Bool = ToBoolean;

/** §5.11: the two outcomes a reviewer can reach. Withdrawing is the member's, not a decision. */
export const APPEAL_OUTCOMES = [AppealState.UPHELD, AppealState.OVERTURNED] as const;

export class CreateAppealDto extends ReasonedDto {
  @ApiProperty({ description: 'The member whose decision is being appealed.' })
  @Trim()
  @IsString()
  memberId: string;

  @ApiProperty({ enum: AppealSubjectType })
  @IsEnum(AppealSubjectType)
  subjectType: AppealSubjectType;

  @ApiProperty({
    description: 'The case, strike, suspension or content verdict being argued with.',
  })
  @Trim()
  @IsString()
  subjectId: string;

  @ApiProperty({
    maxLength: 2000,
    description:
      'The member’s own words, as they said them. Logged by staff rather than typed by the ' +
      'member, because an appeal arrives through Support — so this is a record of what somebody ' +
      'said, and it is what the reviewer reads.',
  })
  @Trim()
  @IsString()
  @MaxLength(2000)
  statement: string;

  @ApiPropertyOptional({ description: 'The Support thread it came in through.' })
  @Trim()
  @IsString()
  @IsOptional()
  supportConversationId?: string;
}

export class ListAppealsDto extends AdminPageOptionsDto {
  @ApiPropertyOptional({ description: 'Comma-separated states. Defaults to `OPEN,IN_REVIEW`.' })
  @CsvArray()
  @IsEnum(AppealState, { each: true })
  @IsOptional()
  state?: AppealState[];

  @ApiPropertyOptional({ description: 'Appeals by this member.' })
  @Trim()
  @IsString()
  @IsOptional()
  memberId?: string;

  @ApiPropertyOptional({ description: 'Only appeals past their SLA.' })
  @Bool()
  @IsBoolean()
  @IsOptional()
  overdue?: boolean;

  @ApiPropertyOptional({ description: 'Only the ones I am reviewing.' })
  @Bool()
  @IsBoolean()
  @IsOptional()
  mine?: boolean;
}

export class DecideAppealDto extends ReasonedDto {
  @ApiProperty({
    enum: APPEAL_OUTCOMES,
    description:
      '`UPHELD` means the original decision stands. `OVERTURNED` undoes it: the strike is ' +
      'revoked, removed content comes back, a suspension is lifted.',
  })
  @IsIn([...APPEAL_OUTCOMES])
  outcome: (typeof APPEAL_OUTCOMES)[number];

  @ApiProperty({
    maxLength: 2000,
    description: 'Why. Required on both outcomes: "we looked again" is not a reason either way.',
  })
  @Trim()
  @IsString()
  @MaxLength(2000)
  decisionNote: string;

  @ApiPropertyOptional({
    maxLength: 500,
    description: 'Shown to the member verbatim, with the outcome.',
  })
  @Trim()
  @IsString()
  @MaxLength(500)
  @IsOptional()
  memberMessage?: string;
}
