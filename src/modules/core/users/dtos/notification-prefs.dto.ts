import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DevicePlatform } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class RegisterDeviceTokenDto {
  @ApiProperty({
    example: 'fHk3mN8xP...',
    description:
      'The FCM registration token for **this** device. Send it on every launch, not only the ' +
      'first: re-registering is how a rotated token replaces the one it replaced. Registering a ' +
      'second device does not displace the first — every signed-in device receives push.',
    maxLength: 512,
  })
  @MaxLength(512)
  @IsString()
  token: string;

  @ApiPropertyOptional({
    enum: DevicePlatform,
    description:
      'Optional, and only ever used for diagnosis: push routes by token, so getting this wrong ' +
      'or omitting it costs nothing.',
  })
  @IsEnum(DevicePlatform)
  @IsOptional()
  platform?: DevicePlatform;
}

export class ReleaseDeviceTokenDto {
  @ApiProperty({
    description: 'The token this device registered, released on sign-out.',
    maxLength: 512,
  })
  @MaxLength(512)
  @IsString()
  token: string;
}
