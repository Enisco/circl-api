import {
  Body,
  Controller,
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
import { CurrentUser, RateLimit, SuccessMessage } from '@/common';
import { ListMessagesDto } from '@/modules/platform/messaging';
import { AdminBffGuard } from '../common/admin-bff.guard';
import { AdminPermissionGuard } from '../common/admin-permission.guard';
import { AdminAnyPermission, AdminPermissions, AdminPrincipal } from '../common/admin-principal';
import {
  AssignSupportThreadDto,
  CreateCannedReplyDto,
  ListCannedRepliesDto,
  ListSupportThreadsDto,
  PatchCannedReplyDto,
  PatchSupportThreadDto,
  SupportReplyDto,
} from '../dtos/admin-support.dto';
import { AdminSupportService } from '../services/admin-support.service';

/**
 * §5.15: the support inbox.
 *
 * Every write opens on **either** `support:manage` or `guard:manage`, and the service decides
 * which one this particular thread actually needs. That looks loose at the route and is the
 * opposite: Support hold `support:manage` and not `guard:manage`, Trust & Safety hold the reverse,
 * and a Guard disclosure is indistinguishable from an ordinary support thread until something
 * reads `SupportThread.type`. Requiring one permission at the route would either lock Trust &
 * Safety out of the disclosures that are theirs to answer, or hand Support the disclosures that
 * are not — so the route admits both and `AdminSupportService` refuses on the thread.
 */
@ApiExcludeController()
@ApiTags('Admin · Support')
@Controller('admin/support')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminSupportController {
  constructor(private readonly support: AdminSupportService) {}

  // ─── Canned replies ────────────────────────────────────────────────────────
  //
  // Declared above `threads/:conversationId` for readability only: the paths do not overlap, so
  // the order is not load-bearing.

  @Get('canned-replies')
  @AdminPermissions('support:read')
  @ApiOperation({
    summary: 'The replies the team sends',
    description: 'Active ones by default — the list the reply box offers.',
  })
  async cannedReplies(@Query() query: ListCannedRepliesDto) {
    return {
      data: await this.support.cannedReplies(query),
      message: SuccessMessage.RESOURCE_FETCHED('Canned replies'),
    };
  }

  @Post('canned-replies')
  @AdminPermissions('support:manage')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({ summary: 'Write a reply once, for the whole team' })
  async createCanned(@CurrentUser() actor: AdminPrincipal, @Body() dto: CreateCannedReplyDto) {
    return {
      data: await this.support.createCanned(actor, dto),
      message: 'Canned reply saved.',
    };
  }

  @Patch('canned-replies/:id')
  @AdminPermissions('support:manage')
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'Edit or retire a canned reply',
    description: '`isActive: false` retires it. Nothing here is ever deleted.',
  })
  async patchCanned(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchCannedReplyDto,
  ) {
    return {
      data: await this.support.patchCanned(actor, id, dto),
      message: 'Canned reply updated.',
    };
  }

  // ─── The inbox ─────────────────────────────────────────────────────────────

  @Get('threads')
  @AdminPermissions('support:read')
  @ApiOperation({
    summary: 'The support inbox',
    description:
      'Open threads by default (`NEW,OPEN,WAITING_ON_MEMBER`), newest member message first. ' +
      '`GUARD` threads are only ever in this list for a caller holding `guard:read` — they are ' +
      'left out of the rows **and** the counts for everybody else (R7).',
  })
  async threads(@CurrentUser() actor: AdminPrincipal, @Query() query: ListSupportThreadsDto) {
    const result = await this.support.list(actor, query);

    return { ...result, message: SuccessMessage.RESOURCE_FETCHED('Support threads') };
  }

  @Get('threads/:conversationId')
  @AdminAnyPermission('support:read', 'guard:read')
  @ApiOperation({
    summary: 'One thread, with everything attached to it',
    description:
      'The member panel, the notes, and what else the thread is linked to — escalations, ' +
      'appeals, a managed request, a dispute, a deal problem or a Guard case.',
  })
  async thread(
    @CurrentUser() actor: AdminPrincipal,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
  ) {
    return {
      data: await this.support.detail(actor, conversationId),
      message: SuccessMessage.RESOURCE_FETCHED('Support thread'),
    };
  }

  @Get('threads/:conversationId/messages')
  @AdminAnyPermission('support:read', 'guard:read')
  @ApiOperation({
    summary: 'Read a support thread',
    description:
      'Marks the thread read for staff. Audited once per staff member per thread per day, ' +
      'because the portal polls this every twenty seconds (§5.15).',
  })
  async messages(
    @CurrentUser() actor: AdminPrincipal,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Query() query: ListMessagesDto,
  ) {
    const result = await this.support.threadMessages(actor, conversationId, query);

    return { ...result, message: SuccessMessage.RESOURCE_FETCHED('Messages') };
  }

  @Post('threads/:conversationId/messages')
  @AdminAnyPermission('support:manage', 'guard:manage')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'Reply as the Circl team',
    description:
      'The member sees a message from Circl in the thread they already have open. Moves the ' +
      'thread to `WAITING_ON_MEMBER` unless `keepOpen`, sets `firstResponseAt` on the first ' +
      'reply, and takes an unassigned thread for the replier (§7.6).',
  })
  async reply(
    @CurrentUser() actor: AdminPrincipal,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: SupportReplyDto,
  ) {
    return {
      data: await this.support.reply(actor, conversationId, dto),
      message: 'Reply sent.',
    };
  }

  @Post('threads/:conversationId/assign')
  @AdminAnyPermission('support:manage', 'guard:manage')
  // 200, not Nest's default 201 for a POST: assigning creates nothing. It is a POST rather than a
  // PATCH because it is an action on the thread with one argument, which is how §5.15 spells it.
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'Hand a thread to somebody',
    description:
      '`assigneeId: null` puts it back in the unassigned queue. The assignee has to hold the ' +
      'permission that answers this kind of thread, or the work lands in a queue they cannot ' +
      'clear while it stops reading as unassigned to everybody who could (B29).',
  })
  async assign(
    @CurrentUser() actor: AdminPrincipal,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: AssignSupportThreadDto,
  ) {
    return {
      data: await this.support.assign(actor, conversationId, dto),
      message: dto.assigneeId ? 'Thread assigned.' : 'Thread unassigned.',
    };
  }

  @Patch('threads/:conversationId')
  @AdminAnyPermission('support:manage', 'guard:manage')
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'Resolve, reopen or tag a thread',
    description:
      'The transitions a person makes by hand (§7.6). The ones a message makes are made where ' +
      'the message is written, not here. An unknown transition is a `409 INVALID_TRANSITION` ' +
      'carrying what was allowed from where the thread actually is.',
  })
  async patch(
    @CurrentUser() actor: AdminPrincipal,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: PatchSupportThreadDto,
  ) {
    return {
      data: await this.support.patch(actor, conversationId, dto),
      message: 'Thread updated.',
    };
  }
}
