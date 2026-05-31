import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, Matches } from 'class-validator';

export class AdminLoginDto {
  @ApiProperty({
    description: "Admin's email address",
    example: 'admin@circl.app',
    format: 'email',
  })
  @IsEmail({}, { message: 'Please provide a valid email address' })
  @IsNotEmpty({ message: 'Email is required' })
  @Transform(({ value }) => value.trim().toLowerCase())
  @Matches(/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, {
    message: 'Please provide a valid email address',
  })
  email: string;

  @ApiProperty({
    description: "Admin's password",
    example: 'StrongP@ss123',
    writeOnly: true,
  })
  @IsString({ message: 'Password must be a string' })
  @IsNotEmpty({ message: 'Password is required' })
  password: string;
}
