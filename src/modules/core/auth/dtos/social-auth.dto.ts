import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { SocialProvider } from '@prisma/client';

export class SocialAuthDto {
  @ApiProperty({
    description: 'Social auth provider',
    enum: SocialProvider,
    example: SocialProvider.GOOGLE,
  })
  @IsEnum(SocialProvider, { message: 'provider must be GOOGLE or APPLE' })
  @IsNotEmpty({ message: 'provider is required' })
  provider: SocialProvider;

  @ApiProperty({
    description: 'Signed JWT identity token from the social provider (RS256)',
    example: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig',
    maxLength: 4096,
  })
  @Matches(/^[\w-]+\.[\w-]+\.[\w-]+$/, { message: 'idToken must be a valid JWT' })
  @MaxLength(4096, { message: 'idToken must not exceed 4096 characters' })
  @IsString({ message: 'idToken must be a string' })
  @IsNotEmpty({ message: 'idToken is required' })
  idToken: string;

  @ApiProperty({
    description: "User's email address as provided by the client (normalised to lowercase)",
    example: 'user@example.com',
    format: 'email',
    maxLength: 254,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @Matches(/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, {
    message: 'Please provide a valid email address',
  })
  @MaxLength(254, { message: 'Email must not exceed 254 characters' })
  @IsEmail({}, { message: 'Please provide a valid email address' })
  @IsNotEmpty({ message: 'email is required' })
  email: string;
}
