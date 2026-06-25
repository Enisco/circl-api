import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class CheckUsernameDto {
  @ApiProperty({
    example: 'john_doe',
    description:
      'Username to check. Must be 3–30 characters: lowercase letters, digits, and underscores only. Must start with a letter.',
    pattern: '^[a-z][a-z0-9_]{2,29}$',
  })
  @Matches(/^[a-z][a-z0-9_]{2,29}$/, {
    message:
      'username must be 3–30 characters, start with a letter, and contain only lowercase letters, digits, and underscores',
  })
  @IsString()
  @IsNotEmpty({ message: 'username is required' })
  username: string;
}
