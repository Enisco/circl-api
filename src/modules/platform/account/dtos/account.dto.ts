import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsOptional, IsString, Length } from 'class-validator';

const Bool = () =>
  Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value));

export class UpdatePrivacyDto {
  @ApiPropertyOptional()
  @Bool()
  @IsBoolean()
  @IsOptional()
  personalisedFeed?: boolean;

  @ApiPropertyOptional()
  @Bool()
  @IsBoolean()
  @IsOptional()
  useActivityForRecommendations?: boolean;

  @ApiPropertyOptional()
  @Bool()
  @IsBoolean()
  @IsOptional()
  showInConnectDiscovery?: boolean;
}

export class ChangeEmailDto {
  @ApiProperty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  newEmail: string;
}

export class ConfirmEmailChangeDto {
  @ApiProperty({ minLength: 6, maxLength: 6 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(6, 6)
  code: string;
}
