import { ApiPropertyOptional } from '@nestjs/swagger';
import { WebsiteSubmissionState, WebsiteSubmissionType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AdminPageOptionsDto, ApiErrorCode, ApiException, CsvArray } from '@/common';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/**
 * The states a submission is still somebody's work. The queue's default.
 *
 * `DONE` and `SPAM` are the history, and a queue that opens on its own history is a queue nobody
 * trusts the badge on.
 */
export const OPEN_SUBMISSION_STATES: WebsiteSubmissionState[] = [
  WebsiteSubmissionState.NEW,
  WebsiteSubmissionState.IN_PROGRESS,
];

/** `q`, inherited from the page options, searches the name, the address, the title and the body. */
export class ListWebsiteSubmissionsDto extends AdminPageOptionsDto {
  @ApiPropertyOptional({ enum: WebsiteSubmissionType, isArray: true, description: 'CSV.' })
  @CsvArray()
  @IsArray()
  @IsEnum(WebsiteSubmissionType, { each: true })
  @ArrayMaxSize(3)
  @IsOptional()
  type?: WebsiteSubmissionType[];

  @ApiPropertyOptional({
    enum: WebsiteSubmissionState,
    isArray: true,
    description: 'CSV. Defaults to `NEW,IN_PROGRESS` — the work, not its history.',
  })
  @CsvArray()
  @IsArray()
  @IsEnum(WebsiteSubmissionState, { each: true })
  @ArrayMaxSize(4)
  @IsOptional()
  state?: WebsiteSubmissionState[];
}

export class PatchWebsiteSubmissionDto {
  @ApiPropertyOptional({
    enum: WebsiteSubmissionState,
    description: 'Moving to the state it is already in is a 200 that changes nothing.',
  })
  @IsEnum(WebsiteSubmissionState)
  @IsOptional()
  state?: WebsiteSubmissionState;

  /**
   * An internal note, filed through §4.7's table like every other staff note.
   *
   * Sent with the state change rather than as a second call, because "closed it, and here is why"
   * is one decision and two requests would let the second fail on its own.
   */
  @ApiPropertyOptional({ minLength: 2, maxLength: 4000 })
  @IsString()
  @Trim()
  @MinLength(2)
  @MaxLength(4000)
  @IsOptional()
  note?: string;

  /**
   * One of the two has to be there.
   *
   * An empty `PATCH` would be a 200 that did nothing, which a portal reads as "saved" — the same
   * refusal the managed pipeline's update makes, for the same reason.
   */
  assertSomethingToDo(): void {
    if (this.state === undefined && this.note === undefined) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'Send something to change: a state, a note, or both.',
        { details: [{ field: 'state', message: 'At least one field is required.' }] },
      );
    }
  }
}
