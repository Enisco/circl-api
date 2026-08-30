import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** One row on the Security screen. */
export class SessionResponseDto {
  @ApiProperty({ example: '9b1c2f6e-6a1b-4a2e-9c9f-2f6b8f1d4a11' })
  id: string;

  @ApiProperty({ example: 'iOS 18.2', description: 'Server-derived from the user agent.' })
  device: string;

  @ApiProperty({ enum: ['IOS', 'ANDROID', 'WEB'], example: 'IOS' })
  platform: 'IOS' | 'ANDROID' | 'WEB';

  @ApiPropertyOptional({
    nullable: true,
    example: null,
    description:
      'City level only, never an address. Currently always null: deriving it needs a GeoIP ' +
      'database, and a wrong city on this screen is worse than none.',
  })
  location: string | null;

  @ApiPropertyOptional({ nullable: true, example: null, description: 'Null for the same reason as `location`.' })
  ipCountry: string | null;

  @ApiProperty({ example: '2026-08-30T07:41:00.000Z' })
  lastSeenAt: string;

  @ApiProperty({ example: '2026-08-02T18:20:00.000Z' })
  createdAt: string;

  @ApiProperty({
    example: true,
    description: 'The device making this call. It cannot be revoked here — use Log out.',
  })
  isCurrent: boolean;
}

export class RevokedResponseDto {
  @ApiProperty({ example: 2, description: 'How many sessions were actually ended.' })
  revoked: number;
}
