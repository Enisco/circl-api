import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReportReason, ReportTargetType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { PageOptionsDto } from '@/common';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class CreateReportDto {
  @ApiProperty({
    enum: ReportTargetType,
    description: 'Also accepted as `subjectType`, which is what the report sheet sends.',
  })
  @IsEnum(ReportTargetType)
  targetType: ReportTargetType;

  @ApiProperty({
    description:
      'For anonymous content, the reportToken from the post is accepted here instead of an id ' +
      '(0.9, D2). Also accepted as `subjectId`.',
  })
  @Trim()
  @IsString()
  targetId: string;

  @ApiProperty({ enum: ReportReason, description: 'Also accepted as `reason`.' })
  @IsEnum(ReportReason)
  reasonCode: ReportReason;

  @ApiPropertyOptional({ maxLength: 1000, description: 'Also accepted as `detail`.' })
  @Trim()
  @IsString()
  @MaxLength(1000)
  @IsOptional()
  note?: string;

  @ApiPropertyOptional({
    default: false,
    description: 'The report sheet offers "Also block this person" as one action.',
  })
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  @IsOptional()
  alsoBlock?: boolean;

  @ApiPropertyOptional({
    description:
      'Who to block alongside the report. An id rather than a boolean, because "also block" on a ' +
      'reported post means block its author and on a reported group means nothing at all. Applied ' +
      'in the same transaction: a member who asked for both and got one is worse off than one who ' +
      'got neither.',
  })
  @Trim()
  @IsString()
  @IsOptional()
  blockUserId?: string;
}

export class CreateBlockDto {
  @ApiProperty({
    description:
      'A user id, or the reportToken of an anonymous post. Someone being harassed anonymously is ' +
      'exactly the person for whom blocking matters most (D2).',
  })
  @Trim()
  @IsString()
  userId: string;
}

export class ListBlocksDto extends PageOptionsDto {}
