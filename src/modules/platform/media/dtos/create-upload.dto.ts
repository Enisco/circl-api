import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MediaPurpose } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class UploadFileDto {
  @ApiProperty({
    example: 'image/jpeg',
    description:
      'One of the accepted image, video or audio types. The presigned signature is minted ' +
      'against this exact value, so a mismatch on the PUT is an opaque S3 rejection.',
  })
  @IsString()
  mimeType: string;

  @ApiProperty({
    example: 842113,
    description: 'The byte length actually sent. Signed into the URL, so it is enforced by S3.',
  })
  @IsInt()
  @Min(1)
  byteSize: number;

  @ApiPropertyOptional({
    example: 14000,
    description:
      'Audio only. Sent here rather than on the message, because only the recording device ' +
      'knows it and it knows it before the bytes leave (5.5).',
  })
  @IsInt()
  @Min(800)
  @Max(300_000)
  @IsOptional()
  durationMs?: number;

  @ApiPropertyOptional({
    type: [Number],
    description:
      'Audio only. 40 normalised amplitudes, 0..1, sampled while recording, so both people ' +
      'see the shape of what was actually said rather than a decoration each device redraws.',
  })
  @IsArray()
  @ArrayMaxSize(40)
  @IsNumber({}, { each: true })
  @IsOptional()
  waveform?: number[];
}

export class CreateUploadDto {
  @ApiProperty({
    enum: MediaPurpose,
    description:
      'Selects the key prefix (0.11.1) and is what the caller is checked against. One of ' +
      'AVATAR, COMMUNITY, PROFESSIONAL, COMMERCE, MESSAGE, VERIFICATION, DISPUTE.',
  })
  @IsEnum(MediaPurpose)
  purpose: MediaPurpose;

  @ApiProperty({
    type: [UploadFileDto],
    description:
      'Batched: one call takes every file in the composer, so five photos cost one round trip.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => UploadFileDto)
  files: UploadFileDto[];
}
