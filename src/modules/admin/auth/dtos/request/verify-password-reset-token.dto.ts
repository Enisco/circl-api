import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, Length, Matches } from 'class-validator';

export class VerifyPasswordResetTokenDto {
  @ApiProperty({ example: 'admin@circl.app', format: 'email' })
  @IsEmail({}, { message: 'Please provide a valid email address' })
  @IsNotEmpty({ message: 'Email is required' })
  @Transform(({ value }) => value.trim().toLowerCase())
  email: string;

  @ApiProperty({ description: '6-digit reset code', example: '123456' })
  @IsString()
  @IsNotEmpty()
  @Length(6, 6, { message: 'Code must be exactly 6 digits' })
  @Matches(/^[0-9]{6}$/, { message: 'Code must contain exactly 6 digits' })
  code: string;
}
