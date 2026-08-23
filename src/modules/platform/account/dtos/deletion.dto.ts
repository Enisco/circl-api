import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';

export class ConfirmDeletionDto {
  @ApiProperty({
    example: '123456',
    description:
      'The 6-digit code sent to the email ON THE ACCOUNT, never to one supplied in the request. ' +
      'That is the whole point: it proves the person deleting the account can read that inbox, so ' +
      'a deletion triggered by someone who picked up an unlocked phone fails here.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(6, 6, { message: 'code must be 6 digits' })
  code: string;
}
