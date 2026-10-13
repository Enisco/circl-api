import { Controller, Get, Header, HttpCode, HttpStatus, Query } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { Public, SuccessMessage } from '@/common';
import { AppPolicyService } from './app-policy.service';

export class VersionPolicyQueryDto {
  @ApiPropertyOptional({
    enum: ['IOS', 'ANDROID'],
    description: 'Defaults to `x-client-platform`.',
  })
  @IsIn(['IOS', 'ANDROID'])
  @IsOptional()
  platform?: 'IOS' | 'ANDROID';

  @ApiPropertyOptional({
    example: '1.4.2',
    description: 'The build asking. Omit it and the answer is the policy with no verdict.',
  })
  @IsString()
  @MaxLength(32)
  @IsOptional()
  version?: string;
}

/**
 * "Do I have to update?" — asked on launch, by a client that may be locked out (§5.21).
 *
 * `@Public()` and deliberately outside everything: an app on a build below the forced floor cannot
 * sign in, so an endpoint behind authentication could not tell it why. For the same reason the
 * force-update interceptor skips this path — a gate that blocks the explanation of the gate is a
 * dead end with no way out of it.
 */
@Controller('app')
@ApiTags('App')
export class AppPolicyController {
  constructor(private readonly policy: AppPolicyService) {}

  @Get('version-policy')
  @Public()
  @HttpCode(HttpStatus.OK)
  // Five minutes, as §5.21 asks. Long enough that a launch spike costs one query and short enough
  // that a force-update set in the portal reaches the fleet inside a coffee break.
  @Header('Cache-Control', 'public, max-age=300')
  @ApiOperation({
    summary: 'Whether this build is still allowed',
    description:
      '`status` is `OK`, `SOFT_UPDATE` (there is a newer build; ask nicely) or `FORCE_UPDATE` ' +
      '(below the floor; the app must not continue). `storeUrl` is where to send them and ' +
      '`message` is what to say, or null to use the app’s own words.\n\n' +
      'Public on purpose: a client below the floor cannot sign in, so an endpoint behind ' +
      'authentication could not tell it why. An unparseable or missing `version` answers `OK` ' +
      'rather than forcing an update — the floor is a statement about builds we know about, and ' +
      'locking somebody out over a header we could not read is the wrong way to be wrong.',
  })
  async versionPolicy(@Query() query: VersionPolicyQueryDto) {
    return {
      data: await this.policy.decide(query.platform ?? null, query.version ?? null),
      message: SuccessMessage.RESOURCE_FETCHED('Version policy'),
    };
  }
}
