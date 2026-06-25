import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

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

export class UpdateNotificationPrefsDto {
  @ApiProperty({ example: true, required: false })
  @IsBoolean()
  @IsOptional()
  newOffersOnMyRequests?: boolean;

  @ApiProperty({ example: true, required: false })
  @IsBoolean()
  @IsOptional()
  newMessages?: boolean;

  @ApiProperty({ example: true, required: false })
  @IsBoolean()
  @IsOptional()
  groupActivity?: boolean;

  @ApiProperty({ example: true, required: false })
  @IsBoolean()
  @IsOptional()
  connectionRequests?: boolean;

  @ApiProperty({ example: true, required: false })
  @IsBoolean()
  @IsOptional()
  platformUpdates?: boolean;
}
