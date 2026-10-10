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
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminJwtGuard } from '@/common/guards/admin-jwt.guard';
import { CurrentUser, Idempotent, RateLimit, SuccessMessage } from '@/common';
import { AdminBffGuard } from '../common/admin-bff.guard';
import { AdminPermissionGuard } from '../common/admin-permission.guard';
import { AdminPermissions, AdminPrincipal } from '../common/admin-principal';
import { AdminTeamService } from '../services/admin-team.service';
import { AdminInviteService } from '../auth/admin-invite.service';
import { AdminCreateInviteDto } from '../dtos/admin-auth.dto';
import {
  ChangeRoleDto,
  ListInvitesDto,
  ListTeamDto,
  ResetCredentialsDto,
  RevokeStaffSessionsDto,
} from '../dtos/admin-team.dto';

@ApiExcludeController()
@ApiTags('Admin · Team')
@Controller('admin/team')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminTeamController {
  constructor(
    private readonly team: AdminTeamService,
    private readonly invites: AdminInviteService,
  ) {}

  @Get()
  @AdminPermissions('team:read')
  @ApiOperation({
    summary: 'The team',
    description:
      'Two kinds of row: accounts, and invitations nobody has accepted yet. The second kind has ' +
      'no account to sort or search by, so they appear on page one as `PENDING` rows carrying ' +
      '`inviteId`. Searches first name, last name and an exact email.',
  })
  async list(@CurrentUser() actor: AdminPrincipal, @Query() query: ListTeamDto) {
    query.assertDepth();

    const { data, meta } = await this.team.list(actor, {
      page: query.currentPage,
      perPage: query.size,
      status: query.status,
      role: query.role,
      q: query.q,
    });

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Team') };
  }

  @Get('roles')
  @AdminPermissions('team:read')
  @ApiOperation({
    summary: 'The role matrix',
    description: 'Read from the seed, so the portal cannot drift from what the API enforces.',
  })
  async roles() {
    return { data: await this.team.roles(), message: SuccessMessage.RESOURCE_FETCHED('Roles') };
  }

  @Get('invites')
  @AdminPermissions('team:read')
  @ApiOperation({ summary: 'Invitations' })
  async listInvites(@Query() query: ListInvitesDto) {
    return {
      data: await this.invites.list(query.state),
      message: SuccessMessage.RESOURCE_FETCHED('Invitations'),
    };
  }

  @Post('invites')
  @AdminPermissions('team:manage')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent({ required: true })
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'Invite somebody',
    description:
      'A role cannot be granted by somebody who does not hold it: a manager may invite a manager, ' +
      'trust & safety or support, and only a super admin may invite a super admin.',
  })
  async invite(@CurrentUser() actor: AdminPrincipal, @Body() dto: AdminCreateInviteDto) {
    const { invite, auditId } = await this.invites.create(actor, dto);

    return { data: invite, meta: { auditId }, message: 'Invitation sent.' };
  }

  @Post('invites/:id/resend')
  @AdminPermissions('team:manage')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'Send the invitation again',
    description:
      'Issues a new token and retires the old one in the same write — two live links for one ' +
      'account would be two ways in. Three sends in total, then no more.',
  })
  async resend(@CurrentUser() actor: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    const { invite, auditId } = await this.invites.resend(actor, id);

    return { data: invite, meta: { auditId }, message: 'Invitation sent again.' };
  }

  @Delete('invites/:id')
  @AdminPermissions('team:manage')
  @ApiOperation({ summary: 'Revoke an invitation' })
  async revokeInvite(@CurrentUser() actor: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    const { invite, auditId } = await this.invites.revoke(actor, id);

    return { data: invite, meta: { auditId }, message: 'Invitation revoked.' };
  }

  @Get(':id')
  @AdminPermissions('team:read')
  @ApiOperation({ summary: 'One staff account, with its sessions' })
  async get(@CurrentUser() actor: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return {
      data: await this.team.get(actor, id),
      message: SuccessMessage.RESOURCE_FETCHED('Staff account'),
    };
  }

  @Patch(':id/role')
  @AdminPermissions('team:manage')
  @Idempotent({ required: true })
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: "Change somebody's role",
    description:
      'Signs them out, so the new role takes effect at their next sign-in rather than whenever ' +
      'their session happened to end. Refuses to demote the last active super admin.',
  })
  async changeRole(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeRoleDto,
  ) {
    const { staff, auditId } = await this.team.changeRole(actor, id, {
      ...dto.assertReasoned(),
      role: dto.role,
    });

    return { data: staff, meta: { auditId }, message: 'Role changed.' };
  }

  @Post(':id/deactivate')
  @AdminPermissions('team:manage')
  @HttpCode(HttpStatus.OK)
  @Idempotent({ required: true })
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'Deactivate a staff account',
    description:
      'Signs them out immediately, retires any outstanding setup link, and returns the queue ' +
      'items and Guard cases they were holding to the unassigned pool — work claimed by somebody ' +
      'who has left is invisible to everybody else.',
  })
  async deactivate(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeRoleDto,
  ) {
    const { staff, auditId, released } = await this.team.deactivate(
      actor,
      id,
      dto.assertReasoned(),
    );

    return {
      data: staff,
      meta: { auditId, releasedWorkItems: released },
      message: 'Account deactivated.',
    };
  }

  @Post(':id/reactivate')
  @AdminPermissions('team:manage')
  @HttpCode(HttpStatus.OK)
  @Idempotent({ required: true })
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'Reactivate a staff account',
    description:
      'Restores the account, not its credentials: coming back needs a fresh password and a fresh ' +
      'authenticator, so a setup link is issued.',
  })
  async reactivate(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeRoleDto,
  ) {
    const { staff, invite, auditId } = await this.team.reactivate(actor, id, dto.assertReasoned());

    return { data: { ...staff, invite }, meta: { auditId }, message: 'Account reactivated.' };
  }

  @Post(':id/reset-credentials')
  @AdminPermissions('team:manage')
  @HttpCode(HttpStatus.OK)
  @Idempotent({ required: true })
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'Reset a password, an authenticator, or both',
    description:
      'There is no self-service password reset, on purpose: an emailed reset link makes a staff ' +
      'inbox enough to become an administrator. This is the replacement, and it signs the account ' +
      'out and strands every setup link issued before it.',
  })
  async resetCredentials(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResetCredentialsDto,
  ) {
    const { invite, auditId } = await this.team.resetCredentials(actor, id, {
      ...dto.assertReasoned(),
      scope: dto.scope,
    });

    return { data: { invite }, meta: { auditId }, message: 'Credentials reset.' };
  }

  @Post(':id/sessions/revoke')
  @AdminPermissions('team:manage')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({ summary: 'Sign somebody out' })
  async revokeSessions(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevokeStaffSessionsDto,
  ) {
    const { revokedCount, auditId } = await this.team.revokeSessions(actor, id, dto.sessionId);

    return { data: { revokedCount }, meta: { auditId }, message: 'Signed out.' };
  }
}
