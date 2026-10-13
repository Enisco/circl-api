import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  Allow,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ReasonedDto } from '@/common';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/**
 * §5.21's `PATCH admin/config/:key`.
 *
 * `value` is `unknown` and validated against the key's own rule in the service, because the shape
 * depends on which key is being written — a DTO per key would be twenty-two DTOs, and a generic
 * `@IsObject()` would refuse the numbers, which is most of them.
 */
export class UpdateConfigDto extends ReasonedDto {
  @ApiProperty({
    description:
      'The new value, in the key’s own shape. Checked against the key’s rule, and a refusal names ' +
      'the field, the limit and what was sent.',
  })
  // `@Allow()` and nothing else, which is load-bearing: the global pipe runs with
  // `forbidNonWhitelisted`, so a property with no validation decorator at all is **stripped and
  // refused** — `property value should not exist`, on every request. There is no decorator for
  // "any shape", because the shape depends on which key is being written, and that is checked in
  // the service against the key's own rule.
  @Allow()
  value: unknown;
}

/** One platform's policy. */
export class PlatformVersionDto {
  @ApiProperty({ example: '1.4.0', description: 'The oldest build still considered current.' })
  @Trim()
  @IsString()
  @MinLength(5)
  @MaxLength(32)
  minimum: string;

  @ApiProperty({ example: '1.5.2', description: 'What is in the store now.' })
  @Trim()
  @IsString()
  @MinLength(5)
  @MaxLength(32)
  latest: string;

  @ApiProperty({
    example: '1.3.0',
    description:
      'Anything **below** this is refused with 426 `APP_UPDATE_REQUIRED`. Setting it is an ' +
      'outage somebody chose: every member on an older build is locked out until they update.',
  })
  @Trim()
  @IsString()
  @MinLength(5)
  @MaxLength(32)
  forceBelow: string;

  @ApiProperty({
    description:
      'Where the update is. The host is fixed per platform — `apps.apple.com` for iOS, ' +
      '`play.google.com` for Android — so a force-update cannot send members to somebody else’s ' +
      'page.',
  })
  @Trim()
  @IsString()
  @MaxLength(500)
  storeUrl: string;

  @ApiPropertyOptional({
    maxLength: 300,
    description: 'Shown on the update screen. Null falls back to the app’s own words.',
  })
  @Trim()
  @IsString()
  @MaxLength(300)
  @IsOptional()
  message?: string;
}

export class UpdateAppVersionsDto extends ReasonedDto {
  @ApiProperty({ type: PlatformVersionDto })
  @ValidateNested()
  @Type(() => PlatformVersionDto)
  @IsObject()
  IOS: PlatformVersionDto;

  @ApiProperty({ type: PlatformVersionDto })
  @ValidateNested()
  @Type(() => PlatformVersionDto)
  @IsObject()
  ANDROID: PlatformVersionDto;
}
