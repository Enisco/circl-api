import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PageOptionsDto } from '@/common';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/** "Private to Circl" (1.9). */
export class CreateGuardThreadDto {
  @ApiProperty({ minLength: 6, maxLength: 200, description: 'What this is about, in a line.' })
  @Trim()
  @IsString()
  @MinLength(6)
  @MaxLength(200)
  subject: string;

  @ApiProperty({ minLength: 1, maxLength: 4000 })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  message: string;

  @ApiPropertyOptional({ description: 'A community category code, if the member picked one.' })
  @Trim()
  @IsString()
  @IsOptional()
  categoryCode?: string;
}

/** A private request to Circl (6.3.1). */
export class CreateGuardRequestDto {
  @ApiProperty({
    description: 'A GUARD_CATEGORY code: HOUSING, IMMIGRATION, SAFETY, MONEY, HEALTH, WORK, OTHER.',
    example: 'HOUSING',
  })
  @Trim()
  @IsString()
  @MaxLength(60)
  categoryCode: string;

  @ApiProperty({ minLength: 10, maxLength: 4000 })
  @Trim()
  @IsString()
  @MinLength(10)
  @MaxLength(4000)
  body: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Object keys under `circl/disputes/{userId}/` (0.11). The composer has no attachment ' +
      'picker yet, so the client omits the field entirely rather than sending [].',
  })
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  @IsOptional()
  mediaKeys?: string[];
}

export class ListGuardThreadsDto extends PageOptionsDto {}

/** 6.3.3. The client sends GB and nothing else today. */
export class ListSupportResourcesDto {
  @ApiPropertyOptional({ default: 'GB', description: 'ISO 3166-1 alpha-2.' })
  @Trim()
  @IsString()
  @MaxLength(2)
  @IsOptional()
  countryCode?: string = 'GB';
}
