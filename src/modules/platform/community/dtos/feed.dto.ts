import { ApiPropertyOptional } from '@nestjs/swagger';
import { FeedFeedbackReason, FeedItemType, RequestStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsArray, IsEnum, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';

const CsvArray = () =>
  Transform(({ value }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map(v => v.trim())
          .filter(Boolean)
      : value,
  );

export class FeedQueryDto {
  @ApiPropertyOptional({ description: 'Opaque cursor. Omit for the first page (0.5).' })
  @IsString()
  @IsOptional()
  cursor?: string;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  limit?: number;

  @ApiPropertyOptional({
    description: "Defaults to the user's city. `ANYWHERE` returns every city.",
  })
  @IsString()
  @IsOptional()
  cityId?: string;

  @ApiPropertyOptional({
    isArray: true,
    enum: FeedItemType,
    description:
      'Backs the "All feeds / Posts / Community Request / Community Service" filter row.',
  })
  @CsvArray()
  @IsArray()
  @IsOptional()
  types?: FeedItemType[];

  @ApiPropertyOptional({
    type: [String],
    description:
      'Selecting any category excludes UPDATE items, which have no category. A client-side product ' +
      'rule the server honours so paging stays consistent (1.1).',
  })
  @CsvArray()
  @IsArray()
  @IsOptional()
  categories?: string[];

  @ApiPropertyOptional({
    enum: RequestStatus,
    default: RequestStatus.OPEN,
    description: 'Applies to REQUEST items only. Never filters out Updates or Guides.',
  })
  @IsEnum(RequestStatus)
  @IsOptional()
  status?: RequestStatus;

  @ApiPropertyOptional({
    enum: ['PERSONALISED', 'LATEST'],
    description:
      'Defaults to PERSONALISED once the member has completed interests onboarding, else LATEST. ' +
      'The member can always switch: ranking that cannot be switched off is ranking that stops ' +
      'being trusted.',
  })
  @IsIn(['PERSONALISED', 'LATEST'])
  @IsOptional()
  ranking?: 'PERSONALISED' | 'LATEST';
}

export class LessLikeThisDto {
  @ApiPropertyOptional({ enum: FeedItemType, description: 'Disambiguates the id space.' })
  @IsEnum(FeedItemType)
  type: FeedItemType;

  @ApiPropertyOptional({ enum: FeedFeedbackReason })
  @IsEnum(FeedFeedbackReason)
  @IsOptional()
  reason?: FeedFeedbackReason;
}
