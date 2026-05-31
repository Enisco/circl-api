import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, Length, Matches, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({ example: 'admin@circl.app', format: 'email' })
  @IsEmail({}, { message: 'Please provide a valid email address' })
  @IsNotEmpty({ message: 'Email is required' })
  @Transform(({ value }) => value.trim().toLowerCase())
  email: string;

  @ApiProperty({
    example: 'StrongP@ss123',
    description: 'New password — at least 8 characters',
    minLength: 8,
  })
  @IsNotEmpty({ message: 'Password is required' })
  @MinLength(8, { message: 'Password must be at least 8 characters long' })
  password: string;

  @ApiProperty({
    description: '6-digit verification code sent to email',
    example: '123456',
    minLength: 6,
    maxLength: 6,
  })
  @IsString({ message: 'Verification code must be a string' })
  @IsNotEmpty({ message: 'Verification code is required' })
  @Length(6, 6, { message: 'Verification code must be exactly 6 digits' })
  @Matches(/^[0-9]{6}$/, { message: 'Verification code must contain exactly 6 digits' })
  code: string;
}
