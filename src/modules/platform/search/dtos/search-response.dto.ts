import { ApiProperty } from '@nestjs/swagger';

export class SearchGroupDto {
  @ApiProperty({
    enum: ['REQUEST', 'GUIDE', 'GROUP', 'PROFESSIONAL', 'CONNECT_PROFILE', 'STORE', 'ITEM'],
    example: 'ITEM',
  })
  type: string;

  @ApiProperty({ example: 'Items', description: 'Rendered verbatim as the section heading.' })
  label: string;

  @ApiProperty({ example: 12, description: 'Total matches, not the number returned.' })
  total: number;

  @ApiProperty({
    type: 'array',
    items: { type: 'object' },
    description:
      "The same object shape that type's own list endpoint returns, so the client reuses its " +
      'existing parsers and cards rather than a bespoke search DTO.',
  })
  items: Record<string, unknown>[];
}

export class SearchResponseDto {
  @ApiProperty({
    type: [SearchGroupDto],
    description:
      'Ordered by relevance, decided server-side, so the strongest match leads rather than a ' +
      'fixed type order. Empty groups are omitted.',
  })
  groups: SearchGroupDto[];

  @ApiProperty({
    type: [String],
    example: ['whiting fish', 'whiting fillet'],
    description: 'Completions drawn from what sellers actually named their items.',
  })
  suggestions: string[];
}
