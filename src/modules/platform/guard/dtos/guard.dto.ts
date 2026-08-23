import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PageOptionsDto } from '@/common';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/**
 * "Private to Circl" (1.9).
 *
 * The Post a Request composer offers this as a third visibility, and it does not
 * create a public post at all — it opens a private thread with Circl's team. The
 * create-request endpoint rejects PRIVATE_TO_CIRCL with USE_PRIVATE_ENDPOINT and
 * the client routes here, because a member who chose private and later finds
 * their question in the feed has been badly failed.
 */
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

export class ListGuardThreadsDto extends PageOptionsDto {}
