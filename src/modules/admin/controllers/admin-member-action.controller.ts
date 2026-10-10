import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Idempotent, RateLimit, SuccessMessage } from '@/common';
import { AdminJwtGuard } from '@/common/guards/admin-jwt.guard';
import { AdminBffGuard } from '../common/admin-bff.guard';
import { AdminPermissionGuard } from '../common/admin-permission.guard';
import { AdminAnyPermission, AdminPermissions, AdminPrincipal } from '../common/admin-principal';
import {
  AnonymiseMemberDto,
  BulkRevokeSessionsDto,
  ChangeSuspensionDto,
  PatchMemberDto,
  ReasonOnlyDto,
  RevokeMemberSessionsDto,
  SuspendMemberDto,
  WarnMemberDto,
} from '../dtos/admin-member-actions.dto';
import { AdminMemberActionService } from '../services/admin-member-action.service';

/**
 * The things staff can do to a member (§5.5).
 *
 * A separate controller from the reads, on the same path prefix. Everything here is a decision with
 * consequences the member feels, so every route carries a reason code, an audit entry and — where
 * repeating it would do damage twice — an idempotency key. Nest matches the more specific route
 * first, so `POST :id/suspend` and the reads on `GET :id/...` coexist without ordering tricks.
 */
@ApiExcludeController()
@ApiTags('Admin · Members')
@Controller('admin')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminMemberActionController {
  constructor(private readonly actions: AdminMemberActionService) {}

  @Patch('members/:id')
  @AdminAnyPermission('members:edit', 'content:moderate')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: "Correct a member's profile",
    description:
      'Per-role allowlist (S10.2): a field your role may not touch is a 403 naming the field, not ' +
      'a blanket refusal. `content:moderate` alone reaches this endpoint for `removeAvatar` and ' +
      'nothing else.\n\n' +
      'A date of birth is locked once set and can only be changed with reason `CORRECTION` or ' +
      '`LEGAL_GDPR` — an age gates Connect and the adult sections, so editing one is a ' +
      'safeguarding change wearing a profile field’s clothes.\n\n' +
      'A change to the email, the phone or the name sends a notice to the **old** address, because ' +
      'if the change was not the member’s idea the new address belongs to whoever made it. An ' +
      'email change leaves the account unverified until the member confirms it.',
  })
  async patch(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchMemberDto,
  ) {
    const { data, auditId } = await this.actions.patch(actor, id, dto);

    return { data, meta: { auditId }, message: SuccessMessage.RESOURCE_UPDATED('Member') };
  }

  @Post('members/:id/sessions/revoke')
  @AdminPermissions('members:sessions')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'Sign a member out',
    description:
      'One session, or all of them when `sessionId` is omitted. Goes through the same revocation ' +
      'the member’s own sign-out uses, so the Redis blacklist key is the one the member ' +
      'strategy checks — a revoke that only updated the database row would leave every issued ' +
      'access token working until it expired.\n\n' +
      'Revoking everything also drops their push devices: a signed-out phone that still receives ' +
      'notifications is the one thing a member reads as "they are still in my account".',
  })
  async revokeSessions(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevokeMemberSessionsDto,
  ) {
    const { data, auditId } = await this.actions.revokeSessions(id, dto);

    return { data, meta: { auditId }, message: 'Signed out' };
  }

  @Post('members/bulk/revoke-sessions')
  @AdminPermissions('members:sessions')
  @HttpCode(HttpStatus.OK)
  @Idempotent({ required: true })
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'Sign several members out',
    description:
      'Up to a hundred. One member’s problem does not stop the rest — a bulk action that ' +
      'aborted half way through would leave nobody able to say which half — so skipped members are ' +
      'logged and the response reports how many were actually done. One audit entry per member, ' +
      'plus a `member.bulk_action` entry for the batch.',
  })
  async bulkRevokeSessions(@Body() dto: BulkRevokeSessionsDto) {
    const { data, auditId } = await this.actions.bulkRevokeSessions(dto);

    return { data, meta: { auditId }, message: 'Signed out' };
  }

  @Post('members/:id/unlock')
  @AdminPermissions('members:sessions')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'Clear a sign-in lockout',
    description:
      'For a member locked out by failed attempts. The same three columns the login path writes, ' +
      'so the next attempt starts from a clean count.',
  })
  async unlock(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonOnlyDto) {
    const { data, auditId } = await this.actions.unlock(id, dto);

    return { data, meta: { auditId }, message: 'Unlocked' };
  }

  @Post('members/:id/suspend')
  @AdminPermissions('members:suspend')
  @HttpCode(HttpStatus.OK)
  @Idempotent({ required: true })
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'Suspend an account',
    description:
      'Writes the `Suspension` record, sets the status, revokes every session **and blacklists ' +
      'them**, drops the push devices, and tells the member with the reason and the appeal route. ' +
      'A suspension that leaves a live access token working is not one.\n\n' +
      '409 when one is already in force: change the existing suspension through ' +
      '`PATCH admin/suspensions/:id`, so two rows cannot disagree about when the account comes back.',
  })
  async suspend(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SuspendMemberDto) {
    const { data, auditId } = await this.actions.suspend(id, dto);

    return { data, meta: { auditId }, message: 'Suspended' };
  }

  @Patch('suspensions/:id')
  @AdminPermissions('members:suspend')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'Extend or shorten a suspension',
    description:
      '`endsAt: null` makes it indefinite. `User.suspendedUntil` moves with it — left behind, the ' +
      'account would come back on the old date.',
  })
  async changeSuspension(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ChangeSuspensionDto) {
    const { data, auditId } = await this.actions.changeSuspension(id, dto);

    return { data, meta: { auditId }, message: SuccessMessage.RESOURCE_UPDATED('Suspension') };
  }

  @Post('members/:id/reactivate')
  @AdminPermissions('members:suspend')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'Put a suspended account back',
    description:
      'Lifts the suspension in force, naming who did it — which is what tells it apart from the ' +
      'expiry job, which sets `liftedAt` and leaves `liftedById` null on purpose. 409 if the ' +
      'account is not suspended.',
  })
  async reactivate(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonOnlyDto) {
    const { data, auditId } = await this.actions.reactivate(id, dto);

    return { data, meta: { auditId }, message: 'Reactivated' };
  }

  @Post('members/:id/warn')
  @AdminPermissions('members:suspend')
  @HttpCode(HttpStatus.OK)
  @Idempotent({ required: true })
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'Warn a member',
    description:
      'A warning is a strike plus a notification — the same row, the difference being whether ' +
      'anybody told them — so this is the one place `notifiedAt` is set. The notice goes through ' +
      'the locked `ACCOUNT` category, so a member who has turned every notification off still ' +
      'hears it.\n\n' +
      'Returns `suggestSuspension` once the strike count reaches the configured threshold. It is a ' +
      'prompt and never an action: nothing on this platform suspends itself.',
  })
  async warn(@Param('id', ParseUUIDPipe) id: string, @Body() dto: WarnMemberDto) {
    const { data, auditId } = await this.actions.warn(id, dto);

    return { data, meta: { auditId }, message: 'Warned' };
  }

  @Post('members/:id/strikes/:strikeId/revoke')
  @AdminPermissions('members:suspend')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'Withdraw a strike',
    description:
      'The row stays: that a strike was issued and then withdrawn is part of the account. A strike ' +
      'already withdrawn or expired is a 404 — there is nothing left to do to it, and a 404 says so ' +
      'without telling a caller probing ids which case it was.',
  })
  async revokeStrike(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('strikeId', ParseUUIDPipe) strikeId: string,
    @Body() dto: ReasonOnlyDto,
  ) {
    const { data, auditId } = await this.actions.revokeStrike(id, strikeId, dto);

    return { data, meta: { auditId }, message: 'Strike withdrawn' };
  }

  @Post('members/:id/data-export')
  @AdminPermissions('members:data_export')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: "Start a member's data export on their behalf",
    description:
      'The member’s own export path, triggered by staff — for a subject access request the ' +
      'member cannot make themselves. 409 while one is already pending.',
  })
  async dataExport(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonOnlyDto) {
    const { data, auditId } = await this.actions.dataExport(id, dto);

    return { data, meta: { auditId }, message: 'Export requested' };
  }

  @Post('members/:id/anonymise')
  @AdminPermissions('members:delete')
  @HttpCode(HttpStatus.OK)
  @Idempotent({ required: true })
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: "Destroy a member's personal data",
    description:
      'Irreversible, so the confirmation is typed rather than clicked: `confirmUsername` must match ' +
      'the member’s username, or their id where they have none. A dialog with a button is ' +
      'dismissed by muscle memory; a name has to be read off the page first.\n\n' +
      'The audit entry is written before the destruction, holding the masked address and its hash — ' +
      'afterwards there is no row left to describe, and that entry is the only remaining way to ' +
      'answer whose account it was.',
  })
  async anonymise(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AnonymiseMemberDto) {
    const { data, auditId } = await this.actions.anonymise(id, dto);

    return { data, meta: { auditId }, message: 'Anonymised' };
  }
}
