import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NoteSubjectType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ToBoolean } from '@/common';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/** A note is evidence, so it has a floor as well as a ceiling: "ok" is not a record of anything. */
const MIN_BODY = 2;
const MAX_BODY = 4000;

export class ListNotesDto {
  @ApiProperty({ enum: NoteSubjectType })
  @IsEnum(NoteSubjectType)
  subjectType: NoteSubjectType;

  @ApiProperty()
  @IsString()
  @MaxLength(64)
  subjectId: string;
}

export class CreateNoteDto {
  @ApiProperty({ enum: NoteSubjectType })
  @IsEnum(NoteSubjectType)
  subjectType: NoteSubjectType;

  @ApiProperty()
  @IsString()
  @MaxLength(64)
  subjectId: string;

  @ApiProperty({ minLength: MIN_BODY, maxLength: MAX_BODY })
  @Trim()
  @IsString()
  @MinLength(MIN_BODY)
  @MaxLength(MAX_BODY)
  body: string;

  @ApiPropertyOptional({ description: 'Pinned notes lead the list and show on the detail page.' })
  @ToBoolean()
  @IsBoolean()
  @IsOptional()
  isPinned?: boolean;
}

/** The member shorthand — `POST admin/members/:id/notes` — where the subject is in the path. */
export class CreateMemberNoteDto {
  @ApiProperty({ minLength: MIN_BODY, maxLength: MAX_BODY })
  @Trim()
  @IsString()
  @MinLength(MIN_BODY)
  @MaxLength(MAX_BODY)
  body: string;

  @ApiPropertyOptional()
  @ToBoolean()
  @IsBoolean()
  @IsOptional()
  isPinned?: boolean;
}

export class PatchNoteDto {
  @ApiPropertyOptional({ minLength: MIN_BODY, maxLength: MAX_BODY })
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(MIN_BODY)
  @MaxLength(MAX_BODY)
  body?: string;

  @ApiPropertyOptional()
  @ToBoolean()
  @IsBoolean()
  @IsOptional()
  isPinned?: boolean;
}
