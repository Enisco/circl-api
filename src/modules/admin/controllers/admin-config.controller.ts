import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Idempotent, RateLimit, SuccessMessage } from '@/common';
import { AdminJwtGuard } from '@/common/guards/admin-jwt.guard';
import { AdminBffGuard } from '../common/admin-bff.guard';
import { AdminPermissionGuard } from '../common/admin-permission.guard';
import { AdminAuthenticated, AdminPermissions, AdminPrincipal } from '../common/admin-principal';
import { UpdateAppVersionsDto, UpdateConfigDto } from '../dtos/admin-config.dto';
import { AdminConfigService } from '../services/admin-config.service';

/**
 * §5.21: the settings that change without a deploy.
 *
 * Reading is `config:read` and writing is `config:system`, which is a much smaller group: these
 * are the numbers the safety pipeline, the deadlines and the app's own gate are computed from, and
 * one of them can lock every member out of the app.
 */
@ApiExcludeController()
@ApiTags('Admin · Configuration')
@AdminAuthenticated()
@Controller('admin/config')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminConfigController {
  constructor(private readonly config: AdminConfigService) {}

  // `app-versions` is declared before `:key`: below it, `GET admin/config/app-versions` would be
  // answered by the generic handler as a setting called "app-versions", which does not exist.

  @Get()
  @AdminPermissions('config:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Every setting, with its default beside it',
    description:
      'Grouped `LIMITS`, `SAFETY`, `SLAS`, `OPERATIONS`. Each entry carries the value in use, the ' +
      'default it would fall back to, the words describing what it does, and the `schema` the ' +
      'form should enforce — so the portal validates the same bounds the API does rather than ' +
      'holding its own copy of them.\n\n' +
      '`value` is read through the same service the platform reads, so what is shown is what is ' +
      'actually in force — including the fallback applied to a stored override of the wrong shape.',
  })
  async list() {
    return {
      data: await this.config.list(),
      message: SuccessMessage.RESOURCE_FETCHED('Configuration'),
    };
  }

  @Get('app-versions')
  @AdminPermissions('config:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The app version policy, and who is on what',
    description:
      '`adoption` is the builds still in use — thirty days of session activity, which is the ' +
      'honest window: a build nobody has opened in a month is not in the wild however many ' +
      'installs it once had. A version used by fewer than ten members reports `null` rather than ' +
      'a number (§2.7), because three people on a build in a small city identifies them.',
  })
  async appVersions() {
    return {
      data: await this.config.appVersions(),
      message: SuccessMessage.RESOURCE_FETCHED('App versions'),
    };
  }

  @Put('app-versions')
  @AdminPermissions('config:system')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @Idempotent()
  @ApiOperation({
    summary: 'Set the version policy for both platforms',
    description:
      '`PUT`, not `PATCH`, because the versions constrain each other: `forceBelow ≤ minimum ≤ ' +
      'latest`. A `forceBelow` sent on its own would be checked against a `minimum` somebody else ' +
      'changed a moment ago, and that ordering is the only thing between a typo and every member ' +
      'of one platform locked out.\n\n' +
      '**`forceBelow` is an outage somebody chose.** Every member below it gets 426 ' +
      '`APP_UPDATE_REQUIRED` on their next request and cannot use the app until they update. The ' +
      'audit entry says, in `metadata.forcesUpdate`, whether this change moved that floor.\n\n' +
      'The store link’s host is fixed per platform — `apps.apple.com` or `play.google.com` — ' +
      'because it is shown on a screen a member cannot dismiss, and a link to somebody else’s ' +
      'page there is phishing with the platform’s own weight behind it.',
  })
  async updateAppVersions(@CurrentUser() actor: AdminPrincipal, @Body() dto: UpdateAppVersionsDto) {
    return { data: await this.config.updateAppVersions(actor, dto), message: 'Policy updated' };
  }

  @Patch(':key')
  @AdminPermissions('config:system')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @Idempotent()
  @ApiOperation({
    summary: 'Change one setting',
    description:
      'Checked against the key’s own rule, and a refusal names the field, the limit and what was ' +
      'sent — `low (300) must be between 0 and 1000`, not a schema pointer.\n\n' +
      '`safety.tierThresholds` must increase: a MEDIUM floor above the HIGH floor is a band ' +
      'nothing can ever land in, and the tiers would stop being reachable rather than fail.\n\n' +
      'A key that does not exist is a 404 carrying the list of keys that do. Takes effect within ' +
      'one read: the cache is cleared here rather than waited out, because this endpoint is also ' +
      'how somebody checks their own change took.',
  })
  async update(
    @CurrentUser() actor: AdminPrincipal,
    @Param('key') key: string,
    @Body() dto: UpdateConfigDto,
  ) {
    return { data: await this.config.update(actor, key, dto), message: 'Setting updated' };
  }
}
