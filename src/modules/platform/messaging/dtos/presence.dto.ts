import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsString } from 'class-validator';

/** Enough for a full inbox page or a group's members, and small enough to stay one round trip. */
export const MAX_PRESENCE_IDS = 100;

export class PresenceQueryDto {
  @ApiProperty({
    description: `Comma-separated member ids, up to ${MAX_PRESENCE_IDS}.`,
    example: 'usr_9,usr_4',
  })
  @Transform(({ value }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map(entry => entry.trim())
          .filter(Boolean)
      : value,
  )
  @IsArray()
  @ArrayMaxSize(MAX_PRESENCE_IDS)
  @IsString({ each: true })
  userIds: string[];
}

export class PresenceDto {
  @ApiProperty({ example: 'usr_9' })
  userId: string;

  @ApiProperty({
    example: true,
    description:
      'True only while the member holds a live socket. Not "recently active": a soft signal here ' +
      'would make the dot a guess.',
  })
  isOnline: boolean;

  @ApiPropertyOptional({
    example: '2026-09-07T15:02:00.000Z',
    nullable: true,
    description:
      'The newest activity across their sessions, whether or not they are online now. Null when ' +
      'they have never signed in, or when the caller cannot see them.',
  })
  lastSeenAt: string | null;
}
