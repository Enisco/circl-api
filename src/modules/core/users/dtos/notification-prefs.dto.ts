import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class RegisterDeviceTokenDto {
  @ApiProperty({
    example: 'fHk3mN8xP...',
    description: 'FCM (Android) or APNs (iOS) push notification token for this device.',
    maxLength: 512,
  })
  @MaxLength(512)
  @IsString()
  token: string;
}

export class ReleaseDeviceTokenDto {
  @ApiProperty({ description: 'The token this device registered, released on sign-out.', maxLength: 512 })
  @MaxLength(512)
  @IsString()
  token: string;
}
