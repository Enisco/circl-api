import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AdminReasonCode, AuditArea } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { AdminPageOptionsDto, CsvArray } from '@/common';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/** `YYYY-MM-DD`, read as a London calendar day (§5.23). */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** The sorts the trail offers. One, and it is the only one a trail is read in. */
export const AUDIT_SORTS = ['occurredAt'] as const;

/**
 * The three client-side events the portal may record (§5.23).
 *
 * An allowlist rather than a free string, because this is the one endpoint where the **client**
 * names the action it is writing into an append-only table. Without it, a compromised or careless
 * portal build could write `member.suspended` entries that nobody took.
 *
 * All three are "somebody took a copy of this away with them", which is the class of act the
 * server cannot see: a CSV is assembled in the browser from data it already had, so there is no
 * request to audit. Everything else on this surface is audited where it happens.
 */
export const CLIENT_EVENTS = [
  'analytics.chart_csv',
  'communications.stats_csv',
  'config.versions_csv',
] as const;

export type ClientEvent = (typeof CLIENT_EVENTS)[number];

/** The filters, shared by `GET admin/audit` and `POST admin/audit/search`. */
export class ListAuditDto extends AdminPageOptionsDto {
  @ApiPropertyOptional({ description: 'Entries by this staff member.' })
  @Trim()
  @IsString()
  @IsOptional()
  actorId?: string;

  @ApiPropertyOptional({
    description:
      'Comma-separated action names, as `GET admin/audit/actions` lists them. An unregistered ' +
      'name matches nothing rather than being refused — the filter is a free-text field in the ' +
      'portal and a stale bookmark should return an empty page, not a 400.',
  })
  @CsvArray()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  @IsOptional()
  action?: string[];

  @ApiPropertyOptional({
    enum: AuditArea,
    isArray: true,
    description:
      'Comma-separated areas. Narrows **within** what the caller may already see (R8): asking ' +
      'for `TEAM` as a `audit:read_area` holder returns their own TEAM actions and nobody ' +
      'else’s, rather than refusing.',
  })
  @CsvArray()
  @IsEnum(AuditArea, { each: true })
  @IsOptional()
  area?: AuditArea[];

  @ApiPropertyOptional({ description: 'The kind of thing acted on — `MEMBER`, `CONVERSATION`, …' })
  @Trim()
  @IsString()
  @MaxLength(60)
  @IsOptional()
  targetType?: string;

  @ApiPropertyOptional({ description: 'One record’s id. Pair with `targetType` where it repeats.' })
  @Trim()
  @IsString()
  @MaxLength(120)
  @IsOptional()
  targetId?: string;

  @ApiPropertyOptional({
    enum: AdminReasonCode,
    description:
      'The reason code given at the time, where one was. An enum rather than free text: unlike ' +
      '`action`, this list is closed, so a value outside it is a client bug worth reporting as a ' +
      '400 rather than an empty page.',
  })
  @Trim()
  @IsEnum(AdminReasonCode)
  @IsOptional()
  reasonCode?: AdminReasonCode;

  @ApiPropertyOptional({
    example: '2026-10-01',
    description: 'London calendar day, inclusive, against `occurredAt`.',
  })
  @Trim()
  @Matches(DATE_ONLY, { message: 'from must be YYYY-MM-DD' })
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({
    example: '2026-10-13',
    description:
      'London calendar day, **inclusive** — `to` is the end of that day, so a single-day range ' +
      'is `from` and `to` set to the same date.',
  })
  @Trim()
  @Matches(DATE_ONLY, { message: 'to must be YYYY-MM-DD' })
  @IsOptional()
  to?: string;

  @ApiPropertyOptional({
    description:
      'Free text against the stored `targetLabel` — the name or title of the thing as it was at ' +
      'the time. Not against `reason` or `metadata`: a reason is somebody’s words about a ' +
      'member, and a trail that can be searched by them is a different thing from one that can ' +
      'be read.',
  })
  @Trim()
  @IsString()
  @MaxLength(120)
  @IsOptional()
  declare q?: string;

  @ApiPropertyOptional({ enum: AUDIT_SORTS, default: 'occurredAt' })
  @Trim()
  @IsIn([...AUDIT_SORTS])
  @IsOptional()
  declare sort?: (typeof AUDIT_SORTS)[number];
}

/**
 * The same filters in a body (§5.23).
 *
 * It exists because the `q` on this endpoint is a member's name and `targetId` is their id, and
 * §2.6 is explicit that member identifiers never reach a URL — a GET writes both into the access
 * log, the browser history and the `Referer` of whatever the reader clicks next. The command
 * palette is a `POST` for the same reason.
 *
 * `GET admin/audit` stays, because the spec asks for both and a filter bar with no identifiers in
 * it is a perfectly good GET.
 */
export class SearchAuditDto extends ListAuditDto {
  @ApiPropertyOptional({
    type: [String],
    description: 'As `action`, but a JSON array rather than a comma-separated string.',
  })
  @IsArray()
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  @IsOptional()
  declare action?: string[];

  @ApiPropertyOptional({
    enum: AuditArea,
    isArray: true,
    description: 'As `area`, as a JSON array.',
  })
  @IsArray()
  @IsEnum(AuditArea, { each: true })
  @IsOptional()
  declare area?: AuditArea[];
}

export class ClientEventDto {
  @ApiProperty({
    enum: CLIENT_EVENTS,
    description:
      'Which copy was taken. Any other action is a `400` — the client may record these three and ' +
      'nothing else, because this is the only path where the caller names what goes into the ' +
      'trail.',
  })
  @Trim()
  @IsIn([...CLIENT_EVENTS])
  action: ClientEvent;

  @ApiPropertyOptional({
    type: Object,
    description:
      'What was taken: the chart id, the filters in force, the row count. Capped at 4 KB — a ' +
      'trail entry is a record of an act, not a copy of the thing acted on.',
  })
  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;
}
