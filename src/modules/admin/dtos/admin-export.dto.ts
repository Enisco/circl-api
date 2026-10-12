import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AdminExportKind } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ToBoolean } from '@/common';

/** §5.26: at most fifty, each at most sixty-four characters, from a small character set. */
const COLUMN_NAME = /^[A-Za-z0-9_ .:-]+$/;

export class CreateExportDto {
  @ApiProperty({ enum: AdminExportKind })
  @IsEnum(AdminExportKind)
  kind!: AdminExportKind;

  @ApiPropertyOptional({
    description:
      "The list endpoint's **filter** params, exactly as the list takes them — and never " +
      '`page`, `perPage`, `sort` or `order`: an export covers every matching row, so a paging ' +
      'param in it would either be ignored or silently cut the file short. Validated against the ' +
      "list's own DTO, so a filter the list refuses is refused here too rather than widened to " +
      '"all rows".',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  filters?: Record<string, unknown>;

  @ApiProperty({
    isArray: true,
    type: String,
    description: "Column keys from the kind's allowlist (§13.18).",
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  @Matches(COLUMN_NAME, { each: true, message: 'columns may only contain A-Z a-z 0-9 _ . : - .' })
  columns!: string[];
}

/**
 * The export list's own query.
 *
 * Deliberately not the shared page options: those carry `q`, `sort` and `order`, and this list
 * sorts newest-first and nothing else. A declared parameter that reaches nothing is worse than an
 * absent one — the portal binds a control to it and the control does nothing — and
 * `forbidNonWhitelisted` turns the absence into a 400 that names the field.
 */
export class ListExportsDto {
  @ApiPropertyOptional({
    description:
      "Everyone's exports rather than your own. Needs `exports:read_all`; ignored without it, " +
      'because a manager who has not been given that permission asking for everything should see ' +
      'their own list, not an error.',
  })
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  all?: boolean;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  perPage?: number;
}
