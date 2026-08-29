import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsString, MaxLength, ValidateNested } from 'class-validator';

export class PreferenceRowDto {
  @ApiProperty({ example: 'REPLIES' })
  @MaxLength(60)
  @IsString()
  code: string;

  @ApiProperty()
  @IsBoolean()
  push: boolean;

  @ApiProperty()
  @IsBoolean()
  email: boolean;
}

export class UpdatePreferencesDto {
  @ApiProperty({
    type: [PreferenceRowDto],
    description:
      'The code and the two booleans. Never `label` or `isLocked`, both of which are the ' +
      "server's to say (6.1.3).",
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PreferenceRowDto)
  categories: PreferenceRowDto[];
}
