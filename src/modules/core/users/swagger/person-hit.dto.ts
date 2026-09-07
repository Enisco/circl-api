import { ApiProperty } from '@nestjs/swagger';

class PersonCityDto {
  @ApiProperty({ example: 'LONDON' })
  id: string;

  @ApiProperty({ example: 'London' })
  name: string;

  @ApiProperty({ example: 'Greater London', nullable: true })
  region: string | null;
}

/**
 * The shared `author` object (0.9) with a `type` stamped on it, so a search result can be handed
 * to the parser the client already uses for authors everywhere else.
 */
export class PersonHitDto {
  @ApiProperty({ example: 'PERSON', enum: ['PERSON'] })
  type: string;

  @ApiProperty({ example: 'usr_9' })
  id: string;

  @ApiProperty({ example: 'Ama O.' })
  displayName: string;

  @ApiProperty({ example: 'amao', nullable: true })
  username: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Signed when it is a Circl upload, verbatim when it came from a social provider.',
  })
  avatarUrl: string | null;

  @ApiProperty({ type: PersonCityDto, nullable: true })
  city: PersonCityDto | null;

  @ApiProperty({
    example: 'NG',
    nullable: true,
    description:
      'ISO 3166-1 alpha-2, for the flag drawn beside the name. Null means draw nothing: the ' +
      'member has not said, chose "Other", or the post is anonymous.',
  })
  countryCode: string | null;

  @ApiProperty({
    example: false,
    description: 'Always false here. Anonymity attaches to a post, not to a person.',
  })
  isAnonymous: boolean;

  @ApiProperty({ type: [String], example: ['EMAIL'] })
  trustChecks: string[];

  @ApiProperty({ example: true })
  isProfessional: boolean;

  @ApiProperty({ example: 'pro_4', nullable: true })
  professionalId: string | null;
}
