import { IsString, IsNotEmpty, IsEmail, Matches, Length, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class VerifyEmailDto {
  @ApiProperty({
    description: "User's email address (normalised to lowercase)",
    example: 'john.doe@example.com',
    format: 'email',
    maxLength: 254,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @Matches(/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, {
    message: 'Please provide a valid email address',
  })
  @MaxLength(254, { message: 'Email must not exceed 254 characters' })
  @IsEmail({}, { message: 'Please provide a valid email address' })
  @IsNotEmpty({ message: 'Email is required' })
  email: string;

  @ApiProperty({
    description: '4-digit verification code received via email',
    example: '4821',
    minLength: 4,
    maxLength: 4,
    pattern: '^[0-9]{4}$',
  })
  @Matches(/^[0-9]{4}$/, { message: 'Verification code must contain exactly 4 digits' })
  @Length(4, 4, { message: 'Verification code must be exactly 4 digits' })
  @IsString({ message: 'Verification code must be a string' })
  @IsNotEmpty({ message: 'Verification code is required' })
  code: string;
}
