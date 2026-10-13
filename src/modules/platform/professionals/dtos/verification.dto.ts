import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

/** The same local helper the listing DTOs use, for the same reason: one trim, no import cycle. */
const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/** §2.4: submitting, or resubmitting, documents for one category. */
export class SubmitVerificationDto {
  @ApiProperty({ description: 'A `PROFESSION` code. The category, never a subcategory.' })
  @IsString()
  categoryCode: string;

  @ApiProperty({
    type: [String],
    description: 'One to five media ids uploaded with `purpose: VERIFICATION`.',
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'Send at least one document.' })
  @ArrayMaxSize(5, { message: 'Five documents at most.' })
  @IsString({ each: true })
  documentIds: string[];

  @ApiPropertyOptional({
    type: [String],
    description:
      'What the documents are being submitted under. **Recorded, not enforced**: approval is ' +
      'category-wide (§2.3). Stored because it is the only thing that would make a narrower ' +
      'scope possible later without a migration.',
  })
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @IsOptional()
  subcategoryCodes?: string[];

  @ApiPropertyOptional({
    maxLength: 500,
    description: 'The member’s own words — a registration number, usually. Shown to the reviewer.',
  })
  @Trim()
  @IsString()
  @MaxLength(500)
  @IsOptional()
  note?: string;
}
