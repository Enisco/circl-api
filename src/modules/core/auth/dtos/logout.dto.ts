import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class LogoutDto {
  @ApiProperty({
    description: 'Whether to revoke all sessions for the user across all devices',
    example: false,
    default: false,
    required: false,
  })
  @IsBoolean({ message: 'revokeAll must be a boolean value' })
  @IsOptional()
  revokeAll?: boolean;
}
