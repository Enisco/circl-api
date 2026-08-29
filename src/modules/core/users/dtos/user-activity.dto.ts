import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { PageOptionsDto } from '@/common';

/** The six things that show up in a member's history (0.16.5). */
export enum ActivityType {
  REQUEST = 'REQUEST',
  OFFER = 'OFFER',
  GUIDE = 'GUIDE',
  UPDATE = 'UPDATE',
  GROUP_POST = 'GROUP_POST',
  REVIEW = 'REVIEW',
}

export class ListUserActivityDto extends PageOptionsDto {
  @ApiPropertyOptional({
    enum: ActivityType,
    description: 'Backs the filter chips. Omit for everything.',
  })
  @IsEnum(ActivityType)
  @IsOptional()
  type?: ActivityType;
}
