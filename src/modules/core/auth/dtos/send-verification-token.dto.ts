import { IsNotEmpty, IsEmail, MaxLength, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class SendVerificationTokenDto {
  @ApiProperty({
    description:
      "User's email address — a 4-digit OTP will be sent here regardless of whether an account exists",
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
}
