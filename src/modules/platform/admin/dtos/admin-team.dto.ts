import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { AdminPageOptionsDto, ReasonedDto } from '@/common';
import { ADMIN_ROLE_CODES } from '../common/admin-policy.service';

export class ListTeamDto extends AdminPageOptionsDto {
  @ApiPropertyOptional({ enum: ['ACTIVE', 'PENDING', 'DEACTIVATED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'PENDING', 'DEACTIVATED'])
  status?: 'ACTIVE' | 'PENDING' | 'DEACTIVATED';

  @ApiPropertyOptional({ enum: [...ADMIN_ROLE_CODES] })
  @IsOptional()
  @IsIn([...ADMIN_ROLE_CODES])
  role?: string;
}

export class ListInvitesDto {
  @ApiPropertyOptional({ enum: ['LIVE', 'EXPIRED', 'ACCEPTED', 'REVOKED'] })
  @IsOptional()
  @IsIn(['LIVE', 'EXPIRED', 'ACCEPTED', 'REVOKED'])
  state?: 'LIVE' | 'EXPIRED' | 'ACCEPTED' | 'REVOKED';
}

export class ChangeRoleDto extends ReasonedDto {
  @ApiPropertyOptional({ enum: [...ADMIN_ROLE_CODES] })
  @IsIn([...ADMIN_ROLE_CODES])
  role: string;
}

export class ResetCredentialsDto extends ReasonedDto {
  @ApiPropertyOptional({
    enum: ['password', 'mfa', 'both'],
    description:
      '`mfa` alone needs no new link: the next sign-in with the existing password returns the ' +
      'enrolment path.',
  })
  @IsIn(['password', 'mfa', 'both'])
  scope: 'password' | 'mfa' | 'both';
}

export class RevokeStaffSessionsDto {
  @ApiPropertyOptional({ description: 'Omit to revoke every session.' })
  @IsOptional()
  @IsUUID()
  sessionId?: string;
}

export class StaffReplyDto {
  @ApiPropertyOptional({ maxLength: 4000 })
  @IsString()
  @MaxLength(4000)
  body: string;
}
