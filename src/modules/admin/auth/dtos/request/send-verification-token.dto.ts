import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsNotEmpty, IsString } from 'class-validator';

export enum AdminVerificationType {
  PASSWORD_RESET = 'password-reset',
}

export class AdminSendVerificationTokenDto {
  @ApiProperty({
    description: 'Verification type',
    example: 'password-reset',
    enum: ['password-reset'],
  })
  @IsNotEmpty({ message: 'type is required' })
  @IsEnum(AdminVerificationType, { message: 'Verification type must be password-reset' })
  @IsString()
  type: AdminVerificationType;

  @ApiProperty({ description: "Admin's email address", example: 'admin@circl.app' })
  @IsEmail({}, { message: 'Please provide a valid email address' })
  @IsNotEmpty({ message: 'Email is required' })
  @Transform(({ value }) => value.trim().toLowerCase())
  email: string;
}
