import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { PageOptionsDto } from '@/common';

export class ListNotificationsDto extends PageOptionsDto {
  @ApiPropertyOptional({
    default: false,
    description:
      'Specified so the endpoint does not need reshaping when the screen grows a filter. The ' +
      'shipped screen requests the first page and nothing else (6.1.1).',
  })
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  @IsOptional()
  unreadOnly?: boolean = false;
}
