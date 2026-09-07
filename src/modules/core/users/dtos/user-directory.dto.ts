import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString } from 'class-validator';
import { PageOptionsDto } from '@/common';

/** `GET /users` is a name search, not a directory listing, so `q` is the whole point of it. */
export class SearchUsersDto extends PageOptionsDto {
  @ApiPropertyOptional({
    description:
      'Matched against display name and username only, never bio or interests. Shorter than two ' +
      'characters returns an empty page rather than the whole membership.',
    example: 'ama',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsOptional()
  q?: string;

  @ApiPropertyOptional({
    description: 'Biases the order towards members in this city. It does not filter them out.',
    example: 'LONDON',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsOptional()
  cityId?: string;
}
