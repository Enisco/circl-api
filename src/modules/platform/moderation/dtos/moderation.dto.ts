import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReportReason, ReportTargetType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { PageOptionsDto } from '@/common';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class CreateReportDto {
  @ApiProperty({ enum: ReportTargetType })
  @IsEnum(ReportTargetType)
  targetType: ReportTargetType;

  @ApiProperty({
    description:
      'For anonymous content, the reportToken from the post is accepted here instead of an id ' +
      '(0.9, D2).',
  })
  @Trim()
  @IsString()
  targetId: string;

  @ApiProperty({ enum: ReportReason })
  @IsEnum(ReportReason)
  reasonCode: ReportReason;

  @ApiPropertyOptional({ maxLength: 1000 })
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
