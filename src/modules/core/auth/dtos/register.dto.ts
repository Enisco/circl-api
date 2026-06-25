import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength, MinLength, IsEnum } from 'class-validator';
import { Gender } from '@prisma/client';
import { Sanitize } from '@/common';

export class RegisterUserDto {
  @ApiProperty({
    description: 'Short-lived JWT issued after OTP or social token verification',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6InVzZXJAZXhhbXBsZS5jb20ifQ.sig',
    maxLength: 2048,
  })
  @Matches(/^[\w-]+\.[\w-]+\.[\w-]+$/, { message: 'signupToken must be a valid JWT' })
  @MaxLength(2048, { message: 'signupToken must not exceed 2048 characters' })
  @IsString({ message: 'signupToken must be a string' })
  @IsNotEmpty({ message: 'signupToken is required' })
  signupToken: string;

  @ApiProperty({ example: 'John', minLength: 1, maxLength: 50 })
  @Sanitize()
  @Matches(/^[a-zA-ZÀ-ÿ'\-\s]+$/, {
    message: 'firstName may only contain letters, spaces, hyphens, and apostrophes',
  })
  @MaxLength(50, { message: 'firstName must be 50 characters or fewer' })
  @MinLength(1, { message: 'firstName must be at least 1 character' })
  @IsString()
  @IsNotEmpty({ message: 'firstName is required' })
  firstName: string;

  @ApiProperty({ example: 'Doe', minLength: 1, maxLength: 50 })
  @Sanitize()
  @Matches(/^[a-zA-ZÀ-ÿ'\-\s]+$/, {
    message: 'lastName may only contain letters, spaces, hyphens, and apostrophes',
  })
  @MaxLength(50, { message: 'lastName must be 50 characters or fewer' })
  @MinLength(1, { message: 'lastName must be at least 1 character' })
  @IsString()
  @IsNotEmpty({ message: 'lastName is required' })
  lastName: string;

  @ApiProperty({ enum: Gender, example: Gender.MALE })
  @IsEnum(Gender, { message: `gender must be one of: ${Object.values(Gender).join(', ')}` })
  @IsNotEmpty({ message: 'gender is required' })
  gender: Gender;
}
