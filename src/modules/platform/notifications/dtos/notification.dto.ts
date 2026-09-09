import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { PageOptionsDto, ToBoolean } from '@/common';

export class ListNotificationsDto extends PageOptionsDto {
  @ApiPropertyOptional({
    default: false,
    description:
      'Specified so the endpoint does not need reshaping when the screen grows a filter. The ' +
      'shipped screen requests the first page and nothing else (6.1.1).',
  })
  @ToBoolean()
  @IsBoolean()
  @IsOptional()
  unreadOnly?: boolean = false;
}

/** What the notification is about, so the client can open a screen without parsing `route` (6.1.1). */
export class NotificationTargetDto {
  @ApiProperty({
    enum: [
      'REQUEST',
      'UPDATE',
      'GUIDE',
      'GROUP',
      'GROUP_POST',
      'CONVERSATION',
      'BOOKING',
      'ORDER',
      'CONNECT_REQUEST',
      'PROFILE',
      'VERIFICATION',
    ],
    example: 'UPDATE',
  })
  type: string;

  @ApiProperty({ example: 'upd_31', description: 'The id of that thing, on its own.' })
  id: string;

  @ApiPropertyOptional({
    description:
      'What the target lives inside, present only where the target cannot be opened without it. ' +
      'Today that is `GROUP_POST`, whose replies live under its group. Same `{ type, id }` shape.',
    example: { type: 'GROUP', id: 'grp_7' },
  })
  parent?: { type: string; id: string };
}

export class NotificationDto {
  @ApiProperty({ example: 'ntf_1' })
  id: string;

  @ApiProperty({
    enum: [
      'REPLY',
      'HELP_OFFER',
      'GROUP',
      'CONNECTION',
      'REVIEW',
      'VERIFICATION',
      'ANNOUNCEMENT',
      'LIKE',
      'BOOKMARK',
      'BOOKING',
    ],
    description: 'Decides the icon and its accent. An unrecognised kind renders as ANNOUNCEMENT.',
  })
  kind: string;

  @ApiProperty({
    example: 'Ada liked your post',
    description: 'Already worded. The client does no string assembly.',
  })
  title: string;

  @ApiProperty({ nullable: true, example: 'Three weeks in and the paperwork is finally done.' })
  body: string | null;

  @ApiProperty({
    enum: ['TODAY', 'THIS_WEEK', 'EARLIER'],
    description: "Computed in the member's timezone.",
  })
  bucket: string;

  @ApiProperty({ example: false })
  isRead: boolean;

  @ApiProperty({
    nullable: true,
    example: '/community/update/upd_31',
    description:
      'Where the row goes when tapped. **Server-owned**, so a new kind is tappable without an app ' +
      'release. Null means the row goes nowhere and only marks itself read.',
  })
  route: string | null;

  @ApiProperty({
    type: NotificationTargetDto,
    nullable: true,
    description:
      'The same destination as `route`, structured, for a client that would rather push a typed ' +
      'screen than a path. Null exactly when `route` is null.',
  })
  target: NotificationTargetDto | null;

  @ApiProperty({
    example: 1,
    description:
      'How many actions this row folded together. 1 unless it collapsed, in which case the title ' +
      'already says so in words.',
  })
  count: number;

  @ApiProperty({
    nullable: true,
    description: 'The shared author object (0.9). Null for ANNOUNCEMENT and VERIFICATION.',
  })
  actor: Record<string, unknown> | null;

  @ApiProperty({ example: '2026-09-08T09:41:02.000Z' })
  createdAt: string;
}
