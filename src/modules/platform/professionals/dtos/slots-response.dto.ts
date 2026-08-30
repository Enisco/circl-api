import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SlotDto {
  @ApiProperty({ example: '09:00', description: 'Local to `timezone`, 24-hour.' })
  start: string;

  @ApiProperty({ example: true })
  isAvailable: boolean;

  @ApiPropertyOptional({
    enum: ['BOOKED', 'OUTSIDE_HOURS', 'BLOCKED'],
    description:
      'Only on an unavailable slot. Sent so the picker can show a disabled chip and the member ' +
      'can see the professional is busy, rather than assuming they do not work then.',
  })
  reason?: 'BOOKED' | 'OUTSIDE_HOURS' | 'BLOCKED';
}

export class SlotDayDto {
  @ApiProperty({ example: '2026-09-01' })
  date: string;

  @ApiProperty({ example: 'Mon 1', description: 'Server-formatted, so the app holds no date vocabulary.' })
  label: string;

  @ApiProperty({ type: [SlotDto] })
  slots: SlotDto[];
}

export class SlotsResponseDto {
  @ApiProperty({ example: 'Europe/London', description: "From the listing's city." })
  timezone: string;

  @ApiProperty({ example: true, description: 'False means the listing refuses new bookings (2.9).' })
  isAcceptingWork: boolean;

  @ApiProperty({ example: true, description: 'Whether "I am flexible" is offered at all.' })
  acceptsFlexible: boolean;

  @ApiProperty({
    type: [SlotDayDto],
    description:
      'Only days the professional actually works. An empty array is a valid answer and the ' +
      'screen falls back to "I am flexible" only.',
  })
  days: SlotDayDto[];
}
