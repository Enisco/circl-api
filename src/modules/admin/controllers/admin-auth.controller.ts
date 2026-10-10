import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminJwtGuard } from '@/common/guards/admin-jwt.guard';
import { CurrentUser, Public, RateLimit, SuccessMessage } from '@/common';
import { AdminBffGuard } from '../common/admin-bff.guard';
import { AdminPermissionGuard } from '../common/admin-permission.guard';
import { AdminAuthenticated, AdminPrincipal } from '../common/admin-principal';
import { AdminAuthService } from '../auth/admin-auth.service';
import { AdminInviteService } from '../auth/admin-invite.service';
import {
  AdminAcceptInviteDto,
  AdminEnrolMfaDto,
  AdminInviteTokenDto,
  AdminLoginDto,
  AdminLogoutDto,
  AdminMfaVerifyDto,
  AdminRefreshDto,
} from '../dtos/admin-auth.dto';

/**
 * Staff sign-in.
 *
 * `@Public()` with respect to the bearer token, but **not** with respect to the trusted-client
 * credential: these endpoints still have to come through the portal's own server, which is what
 * keeps the admin surface unreachable from the open internet even before anybody has a token.
 *
 * Tokens are returned in the JSON body and never as cookies. The portal holds them server-side in
 * an encrypted session cookie of its own, so a token never reaches the browser and there is no
 * cross-site request forgery surface on this API to protect.
 */
@ApiExcludeController()
@ApiTags('Admin · Authentication')
@Controller('admin/auth')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminAuthController {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly invites: AdminInviteService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_LOGIN')
  @ApiOperation({
    summary: 'Step one: email and password',
    description:
      'Never completes a sign-in on its own. Returns a short-lived ticket for the second factor, ' +
      'or the enrolment path when no authenticator is set up yet.\n\n' +
      'Every failure — unknown email, not staff, deactivated, wrong password, locked, MFA not ' +
      'enrolled — returns the same 401 `INVALID_CREDENTIALS` in about the same time. The account ' +
      'owner is told about a lock by email, which is a channel an attacker does not control.',
  })
  async login(@Body() dto: AdminLoginDto) {
    const data = await this.auth.login(dto.email, dto.password);

    return { data, message: 'Continue with your authenticator.' };
  }

  @Public()
  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_MFA')
  @ApiOperation({
    summary: 'Step two: the authenticator code, or a recovery code',
    description:
      'Creates the session. A recovery code is accepted here in either case and with or without ' +
      'its hyphen, because somebody reading one off paper at a bad moment should not be refused ' +
      'over punctuation — and using one emails the account owner.',
  })
  async verifyMfa(@Body() dto: AdminMfaVerifyDto) {
    const data = await this.auth.verifyMfa(dto.mfaToken, dto.code);

    return { data, message: 'Signed in.' };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_REFRESH')
  @ApiOperation({
    summary: 'Rotate the token pair',
    description:
      'Each refresh issues a new pair and retires the old one. Two requests presenting the same ' +
      'token within thirty seconds both get the pair rotation produced — the portal runs more ' +
      'than one process and they can race. Outside that window the same token is a replay, and ' +
      'the session is revoked.',
  })
  async refresh(@Body() dto: AdminRefreshDto) {
    const data = await this.auth.refresh(dto.refreshToken);

    return { data, message: 'Refreshed.' };
  }

  @Post('logout')
  @AdminAuthenticated()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End this session' })
  async logout(@CurrentUser() actor: AdminPrincipal, @Body() _dto: AdminLogoutDto) {
    await this.auth.logout(actor.sessionId, actor.id);

    return { data: { revoked: true }, message: 'Signed out.' };
  }

  @Public()
  @Post('invites/inspect')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_INVITE_INSPECT')
  @ApiOperation({
    summary: 'What an invitation is for',
    description:
      'The token arrives in the body, never in a URL: a URL ends up in browser history, in ' +
      'referrer headers and in server logs. Every invalid state answers identically, so this ' +
      'cannot be used to find out which addresses have been invited.',
  })
  async inspect(@Body() dto: AdminInviteTokenDto) {
    const data = await this.invites.inspect(dto.token);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Invitation') };
  }

  @Public()
  @Post('invites/accept')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit('ADMIN_SETUP')
  @ApiOperation({
    summary: 'Set a password and start enrolling an authenticator',
    description:
      'The account exists after this but cannot sign in until enrolment completes. `secret` is ' +
      'returned for anyone typing it in by hand rather than scanning the QR code.',
  })
  async accept(@Body() dto: AdminAcceptInviteDto) {
    const account = await this.invites.accept(dto);
    const setup = await this.auth.beginEnrolment(account.userId, account.email, account.epoch);

    return { data: setup, message: 'Now add Circl Admin to your authenticator app.' };
  }

  @Public()
  @Post('mfa/enroll')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit('ADMIN_SETUP')
  @ApiOperation({
    summary: 'Confirm the authenticator and finish setting up',
    description:
      'Returns the ten recovery codes **once**: this is the only moment they exist outside the ' +
      'holder\'s own notes. Stored as hashes, so they cannot be shown again.',
  })
  async enrol(@Body() dto: AdminEnrolMfaDto) {
    const data = await this.auth.enrol(dto.mfaSetupToken, dto.code);

    return { data, message: 'Save your recovery codes somewhere safe. They are shown once.' };
  }
}
