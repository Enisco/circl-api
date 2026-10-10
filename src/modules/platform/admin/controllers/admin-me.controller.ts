import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminJwtGuard } from '@/common/guards/admin-jwt.guard';
import { CurrentUser, RateLimit, SuccessMessage } from '@/common';
import { AdminBffGuard } from '../common/admin-bff.guard';
import { AdminPermissionGuard } from '../common/admin-permission.guard';
import { AdminAuthenticated, AdminPrincipal } from '../common/admin-principal';
import { AdminMeService } from '../services/admin-me.service';
import {
  AdminChangePasswordDto,
  AdminReauthenticateDto,
  AdminUpdateProfileDto,
} from '../dtos/admin-auth.dto';

/** A staff member's own account. Everything here is `@AdminAuthenticated()`: it is about themselves. */
@ApiExcludeController()
@ApiTags('Admin · Me')
@Controller('admin/me')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminMeController {
  constructor(private readonly me: AdminMeService) {}

  @Get()
  @AdminAuthenticated()
  @ApiOperation({
    summary: 'Who I am and what I may do',
    description:
      '`permissions` is for drawing the UI. It is re-resolved from the role on every request, so ' +
      'a stale copy in the browser cannot grant anything.',
  })
  async get(@CurrentUser() actor: AdminPrincipal) {
    return {
      data: await this.me.me(actor),
      message: SuccessMessage.RESOURCE_FETCHED('Your account'),
    };
  }

  @Patch()
  @AdminAuthenticated()
  @ApiOperation({ summary: 'Change my name' })
  async update(@CurrentUser() actor: AdminPrincipal, @Body() dto: AdminUpdateProfileDto) {
    const { me, auditId } = await this.me.updateProfile(actor, dto);

    return { data: me, meta: { auditId }, message: 'Saved.' };
  }

  @Post('password')
  @AdminAuthenticated()
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_REAUTH')
  @ApiOperation({
    summary: 'Change my password',
    description:
      'Needs the current password **and** a live authenticator code. The threat is a machine ' +
      'somebody walked away from, where the old password is already in the password manager. ' +
      'Signs out every other session and emails the account owner.',
  })
  async changePassword(
    @CurrentUser() actor: AdminPrincipal,
    @Body() dto: AdminChangePasswordDto,
  ) {
    const { auditId } = await this.me.changePassword(actor, dto);

    return { data: { changed: true }, meta: { auditId }, message: 'Password changed.' };
  }

  @Post('mfa/recovery-codes')
  @AdminAuthenticated()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit('ADMIN_REAUTH')
  @ApiOperation({
    summary: 'Replace my recovery codes',
    description:
      'Invalidates the old set. Deliberately not replayable through `Idempotency-Key`: a response ' +
      'carrying secrets must not be stored for a retry to hand back later.',
  })
  async regenerate(@CurrentUser() actor: AdminPrincipal, @Body() dto: AdminReauthenticateDto) {
    const { recoveryCodes, auditId } = await this.me.regenerateRecoveryCodes(actor, dto);

    return {
      data: { recoveryCodes },
      meta: { auditId },
      message: 'These replace your old codes and are shown once.',
    };
  }

  @Get('sessions')
  @AdminAuthenticated()
  @ApiOperation({ summary: 'Where I am signed in' })
  async sessions(@CurrentUser() actor: AdminPrincipal) {
    return {
      data: await this.me.sessions_(actor),
      message: SuccessMessage.RESOURCE_FETCHED('Sessions'),
    };
  }

  @Delete('sessions/:id')
  @AdminAuthenticated()
  @ApiOperation({ summary: 'Sign out one other session' })
  async revokeSession(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const { auditId } = await this.me.revokeSession(actor, id);

    return { data: { revoked: true }, meta: { auditId }, message: 'Signed out.' };
  }

  @Post('sessions/revoke-others')
  @AdminAuthenticated()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign out everywhere except here' })
  async revokeOthers(@CurrentUser() actor: AdminPrincipal) {
    const { revokedCount, auditId } = await this.me.revokeOtherSessions(actor);

    return { data: { revokedCount }, meta: { auditId }, message: 'Signed out elsewhere.' };
  }
}
