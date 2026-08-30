import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PrivacyResponseDto {
  @ApiProperty({
    example: true,
    description:
      'False really does fall `GET /community/feed` back to plain recency and city, so the ' +
      'switch is not decorative.',
  })
  personalisedFeed: boolean;

  @ApiProperty({ example: true })
  useActivityForRecommendations: boolean;

  @ApiProperty({ example: true })
  showInConnectDiscovery: boolean;

  @ApiPropertyOptional({ nullable: true, example: '2026-08-30T07:00:00.000Z' })
  updatedAt: string | null;
}

export class DataExportResponseDto {
  @ApiProperty({ example: 'a4f1c0de-4e5b-4a19-9d3f-9a0f0a6b1c22' })
  id: string;

  @ApiProperty({ enum: ['PENDING', 'READY', 'EXPIRED', 'FAILED'], example: 'PENDING' })
  status: string;

  @ApiProperty({ example: '2026-08-30T07:00:00.000Z' })
  requestedAt: string;

  @ApiPropertyOptional({ nullable: true, example: null })
  readyAt?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: null,
    description: 'Null: delivery is by emailed link, so the client only reports the status.',
  })
  downloadUrl?: string | null;

  @ApiPropertyOptional({ nullable: true, example: null })
  expiresAt?: string | null;
}

export class EmailChangeStartedDto {
  @ApiProperty({ example: 'new@example.com' })
  newEmail: string;

  @ApiProperty({ example: 600, description: 'How long the six-digit code stays valid.' })
  expiresInSeconds: number;
}
