import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { StrictBoolean } from '@/common';
import { ADMIN_ROLE_CODES } from '../common/admin-policy.service';

const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
const Lower = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value));

export class AdminLoginDto {
  @ApiProperty({ example: 'staff@circl.app' })
  @Lower()
  @IsEmail()
  @MaxLength(254)
  email: string;

  // Not length-validated on the way in beyond an upper bound: the policy applies when a password is
  // SET, and enforcing it at sign-in would tell a caller whether a short guess was even considered.
  @ApiProperty()
  @IsString()
  @Length(1, 256)
  password: string;
}

export class AdminMfaVerifyDto {
  @ApiProperty({ description: 'The token returned by the password step.' })
  @IsString()
  @Length(10, 200)
  mfaToken: string;

  @ApiProperty({ description: 'A 6-digit authenticator code, or a recovery code.' })
  @Trim()
  @IsString()
  @Length(6, 20)
  code: string;
}

export class AdminRefreshDto {
  @ApiProperty()
  @IsString()
  @Length(10, 300)
  refreshToken: string;
}

export class AdminLogoutDto {
  @ApiPropertyOptional({ description: 'Only needed when the access token has already expired.' })
  @IsOptional()
  @IsString()
  @Length(10, 300)
  refreshToken?: string;
}

export class AdminInviteTokenDto {
  @ApiProperty()
  @IsString()
  @Length(10, 200)
  token: string;
}

export class AdminAcceptInviteDto extends AdminInviteTokenDto {
  @ApiProperty()
  @Trim()
  @IsString()
  @Length(1, 60)
  firstName: string;

  @ApiProperty()
  @Trim()
  @IsString()
  @Length(1, 60)
  lastName: string;

  @ApiProperty({ minLength: 12, maxLength: 128 })
  @IsString()
  @Length(1, 256)
  password: string;
}

export class AdminEnrolMfaDto {
  @ApiProperty()
  @IsString()
  @Length(10, 200)
  mfaSetupToken: string;

  @ApiProperty({ description: 'The 6-digit code from the authenticator app.' })
  @Trim()
  @IsString()
  @Length(6, 10)
  code: string;
}

export class AdminCreateInviteDto {
  @ApiProperty({ example: 'newstaff@circl.app' })
  @Lower()
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({ enum: [...ADMIN_ROLE_CODES] })
  @IsIn([...ADMIN_ROLE_CODES])
  role: string;
}

export class AdminChangePasswordDto {
  @ApiProperty()
  @IsString()
  @Length(1, 256)
  currentPassword: string;

  @ApiProperty({ minLength: 12, maxLength: 128 })
  @IsString()
  @Length(1, 256)
  newPassword: string;

  @ApiProperty({
    description: 'A current authenticator code: a password change is re-authenticated.',
  })
  @Trim()
  @IsString()
  @Length(6, 20)
  code: string;
}

export class AdminReauthenticateDto {
  @ApiProperty()
  @IsString()
  @Length(1, 256)
  password: string;

  @ApiProperty()
  @Trim()
  @IsString()
  @Length(6, 20)
  code: string;
}

export class AdminUpdateProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 60)
  firstName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 60)
  lastName?: string;

  @ApiPropertyOptional({ description: 'Not supported yet: staff photo upload has not shipped.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  avatarMediaId?: string | null;
}

/** §5.2's three alert toggles. Named rather than a free map, so an unknown key is a 400. */
export class AdminAlertPreferencesDto {
  @ApiPropertyOptional({ description: 'An URGENT report arriving.' })
  @StrictBoolean()
  @IsOptional()
  urgentReports?: boolean;

  @ApiPropertyOptional({ description: 'A CRITICAL Guard case opening.' })
  @StrictBoolean()
  @IsOptional()
  criticalGuard?: boolean;

  @ApiPropertyOptional({ description: 'Work being assigned to me.' })
  @StrictBoolean()
  @IsOptional()
  assignedToMe?: boolean;
}

/**
 * §5.2's staff preferences.
 *
 * `alerts` is **merged**, not replaced: the portal's settings screen has three switches and sends
 * the one that moved. Replacing would mean a screen that saves one toggle silently turning the
 * other two off — which for `criticalGuard` is somebody who stops being told about safeguarding
 * cases and has no way to know it happened.
 */
export class AdminPreferencesDto {
  @ApiPropertyOptional({ enum: ['light', 'dark', 'system'] })
  @IsIn(['light', 'dark', 'system'])
  @IsOptional()
  theme?: 'light' | 'dark' | 'system';

  @ApiPropertyOptional({ type: AdminAlertPreferencesDto })
  @ValidateNested()
  @Type(() => AdminAlertPreferencesDto)
  @IsOptional()
  alerts?: AdminAlertPreferencesDto;
}
