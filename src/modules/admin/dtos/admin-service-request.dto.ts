import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BriefUrgency, ServiceRequestState } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AdminPageOptionsDto, CsvArray } from '@/common';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/** The states a request is still somebody's work. The queue's default. */
export const OPEN_REQUEST_STATES: ServiceRequestState[] = [
  ServiceRequestState.SUBMITTED,
  ServiceRequestState.MATCHING,
];

/** `q`, inherited from the page options, searches the member's own words. */
export class ListServiceRequestsDto extends AdminPageOptionsDto {
  @ApiPropertyOptional({
    enum: ServiceRequestState,
    isArray: true,
    description: 'CSV. Defaults to `SUBMITTED,MATCHING` — the work, not its history.',
  })
  @CsvArray()
  @IsArray()
  @IsEnum(ServiceRequestState, { each: true })
  @ArrayMaxSize(5)
  @IsOptional()
  state?: ServiceRequestState[];

  @ApiPropertyOptional({ enum: BriefUrgency, isArray: true, description: 'CSV.' })
  @CsvArray()
  @IsArray()
  @IsEnum(BriefUrgency, { each: true })
  @ArrayMaxSize(4)
  @IsOptional()
  urgency?: BriefUrgency[];

  @ApiPropertyOptional({ isArray: true, description: 'CSV of city ids.' })
  @CsvArray()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  @IsOptional()
  cityIds?: string[];

  @ApiPropertyOptional({
    description:
      'CSV of profession category codes. Matches either the member’s guess or the category ' +
      'staff decided on.',
    isArray: true,
  })
  @CsvArray()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  @IsOptional()
  categories?: string[];

  @ApiPropertyOptional({
    description:
      'Only requests nobody has categorised yet — the ones that need a person before anything ' +
      'else can happen.',
    enum: ['true'],
  })
  @IsIn(['true'])
  @IsOptional()
  uncategorised?: string;

  @ApiPropertyOptional({ description: 'ISO date.' })
  @IsDateString()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO date.' })
  @IsDateString()
  @IsOptional()
  to?: string;
}

export class SetRequestCategoryDto {
  @ApiProperty({
    description:
      'A profession category code. Recorded as **Circl’s** decision, beside the member’s own ' +
      'guess rather than over it.',
  })
  @Trim()
  @IsString()
  @MinLength(1)
  categoryCode: string;
}

/** `q`, inherited from the page options, matches a name, a listing title or a service's name. */
export class SearchProfessionalsDto extends AdminPageOptionsDto {
  @ApiPropertyOptional({ description: 'A profession category code.' })
  @Trim()
  @IsString()
  @IsOptional()
  categoryCode?: string;

  @ApiPropertyOptional({ description: 'A city id.' })
  @Trim()
  @IsString()
  @IsOptional()
  cityId?: string;
}

export class OfferRequestDto {
  @ApiProperty({
    isArray: true,
    description:
      'The professionals to offer it to, by user id. Each gets one offer; offering to somebody ' +
      'who already has one is ignored rather than refused, so a double-tap cannot send two.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsUUID('4', { each: true })
  professionalIds: string[];
}

/** What staff are telling the member. */
export const REQUEST_OUTCOMES = ['FOUND', 'NONE'] as const;
export type RequestOutcome = (typeof REQUEST_OUTCOMES)[number];

export class SendOutcomeDto {
  @ApiProperty({
    enum: REQUEST_OUTCOMES,
    description:
      '`FOUND` — professionals are taking it on; needs at least one acceptance. `NONE` — nobody ' +
      'was available, which closes the request and revokes anything still outstanding.',
  })
  @IsIn([...REQUEST_OUTCOMES])
  outcome: RequestOutcome;

  @ApiPropertyOptional({
    maxLength: 500,
    description:
      'Circl’s own sentence to the member, shown under the status on their request. This is ' +
      'where "we have asked two agencies" goes. Never templated, and optional.',
  })
  @Trim()
  @IsString()
  @MaxLength(500)
  @IsOptional()
  note?: string;
}
