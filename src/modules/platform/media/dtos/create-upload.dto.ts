import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class UploadFileDto {
  @ApiProperty({
    example: 'image/jpeg',
    description: 'One of the accepted image, video or audio types.',
  })
  @IsString()
  mimeType: string;

  @ApiProperty({
    example: 842113,
    description: 'Size in bytes, so the limit is enforced before the upload starts.',
  })
  @IsInt()
  @Min(1)
  byteSize: number;

  @ApiProperty({
    required: false,
    example: 14000,
    description: 'Audio only. Only the recording device knows this (spec 5.5).',
  })
  @IsInt()
  @Min(800)
  @Max(300_000)
  @IsOptional()
  durationMs?: number;

  @ApiProperty({
    required: false,
    type: [Number],
    description:
      'Audio only. 40 normalised amplitudes, 0..1, sampled while recording, so both people ' +
      'see the shape of what was actually said rather than a decoration each device redraws.',
  })
  @IsArray()
  @ArrayMaxSize(40)
  @IsOptional()
  waveform?: number[];
}

export class CreateUploadDto {
  @ApiProperty({ type: [UploadFileDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => UploadFileDto)
  files: UploadFileDto[];
}
