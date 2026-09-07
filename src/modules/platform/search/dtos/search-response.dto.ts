import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SEARCH_TYPES } from './search.dto';

export class SearchGroupDto {
  @ApiProperty({ enum: SEARCH_TYPES, example: 'REQUEST' })
  type: string;

  @ApiProperty({ example: 'Requests', description: 'Rendered verbatim as the section heading.' })
  label: string;

  @ApiProperty({
    example: 24,
    description:
      'The full number of matches for this type, not the number returned. This is what "See all ' +
      '24" shows, and it is the only reason the grouped view is worth a dedicated endpoint. It is ' +
      'exact, not capped.',
  })
  totalCount: number;

  @ApiProperty({
    example: 24,
    deprecated: true,
    description: 'The same number under its original name.',
  })
  total: number;

  @ApiProperty({
    type: 'array',
    items: { type: 'object' },
    description:
      "The rows that type's own list endpoint returns, plus the fields that say what each row is " +
      '— the ordinary shape, never a wrapper, so the client hands the row to the parser it ' +
      'already has.\n\n' +
      '`resultType` is **always** the search type code, on every item of every type. Dispatch on ' +
      'it, or on `group.type`.\n\n' +
      '`type` is the search type code too, except on the two rows that already own a `type` ' +
      "meaning something else: a Connect profile's connection type (FRIENDSHIP, DATING) and a " +
      "shop's shop type (Grocery, Salon). Those keep their own value, mirrored onto " +
      '`connectionType` and `storeType`, because overwriting it would blank a field the card ' +
      'renders. Once the client reads the mirrors, `type` becomes the code everywhere.',
  })
  items: Record<string, unknown>[];

  @ApiPropertyOptional({
    example: 'CONNECT_PROFILE_REQUIRED',
    description:
      'Present only when the caller may not search this type, with `items` empty. A gate is a ' +
      'group status and never a response status: a 403 on the whole call would let one gated type ' +
      'destroy every other group.',
  })
  gate?: string;

  @ApiPropertyOptional({
    example: true,
    description:
      'Present only when this one type timed out or errored. Every other group is unaffected, and ' +
      'the client can retry or say nothing. Absent means the empty group is a real empty result.',
  })
  degraded?: boolean;
}

export class SearchResponseDto {
  @ApiProperty({
    type: [SearchGroupDto],
    description:
      'One group per requested type, **including empty ones**: the app hides those itself, and a ' +
      'present-but-empty group is how it tells "nothing matched" from "you did not ask for that ' +
      'type". Ranking happens within a group, never across groups, because the app renders groups ' +
      'in its own order and a global ordering would be computed and then thrown away.',
  })
  groups: SearchGroupDto[];

  @ApiProperty({
    type: [String],
    example: ['whiting fish', 'whiting fillet'],
    description: 'Completions drawn from what sellers actually named their items.',
  })
  suggestions: string[];
}
