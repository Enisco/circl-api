import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminJwtGuard } from '@/common/guards/admin-jwt.guard';
import { ApiException, CurrentUser, Idempotent, RateLimit, SuccessMessage } from '@/common';
import { PrismaService } from '@/infrastructure';
import {
  ConversationFactoryService,
  ListMessagesDto,
  MessageService,
  SendMessageDto,
} from '@/modules/platform/messaging';
import { AdminBffGuard } from '../common/admin-bff.guard';
import { AdminPermissionGuard } from '../common/admin-permission.guard';
import { AdminPermissions, AdminPrincipal } from '../common/admin-principal';
import { AuditService } from '../audit/audit.service';
import { GrantThreadAccessDto } from '../dtos/admin-thread-access.dto';
import { AdminThreadAccessService } from '../services/admin-thread-access.service';
import { toAdminMessages } from '../serializers/admin-message.serializer';

/**
 * How long one recorded read covers.
 *
 * The key carries the calendar date, so the window is "today" in the ordinary sense rather than a
 * rolling 24 hours — somebody reading a case at 23:55 and again at 00:05 has read it on two days,
 * and the trail should say so. The TTL is a day and a bit, so a key cannot outlive the date it
 * names and silently suppress tomorrow's first read.
 */
const THREAD_READ_WINDOW_SECONDS = 26 * 3600;

/**
 * Where the grant id is carried (S9.2).
 *
 * A header rather than a query parameter, because a grant id is a credential for thirty minutes
 * and a url ends up in access logs, in the portal's own history, and in whatever somebody pastes
 * into a chat when they ask a colleague to take a look.
 */
const THREAD_ACCESS_HEADER = 'x-thread-access-grant';

/**
 * Staff replies in Guard cases (§5.12).
 *
 * Here because member authentication refuses staff accounts, and staff used to reply by signing in
 * to the app — which was the hole: a staff inbox was an administrator login (B1). The reply itself
 * still goes through the ordinary message service, so a member sees what they always saw: a
 * message from the Circl team in the thread they already have open.
 *
 * The two support-thread routes that used to live here moved to `AdminSupportController` when
 * §5.15's inbox landed, and the move fixed a hole of its own: they admitted any conversation whose
 * `contextType` was `SUPPORT`, which is every safeguarding disclosure as well (D36), so
 * `support:read` was enough to read one. The inbox consults `SupportThread.type` instead.
 *
 * A Guard case keeps its own endpoints rather than being folded into the inbox, because it is
 * addressed by `GuardThread.id` — the case, as §5.12's queue names it — and not by the
 * conversation it happens to use.
 */
@ApiExcludeController()
@ApiTags('Admin · Threads')
@Controller('admin')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminThreadController {
  constructor(
    private readonly database: PrismaService,
    private readonly messages: MessageService,
    private readonly conversations: ConversationFactoryService,
    private readonly audit: AuditService,
    private readonly access: AdminThreadAccessService,
  ) {}

  // ─── §5.6: members' private threads ────────────────────────────────────────

  @Post('threads/:conversationId/access')
  @AdminPermissions('messages:read')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit('ADMIN_WRITE')
  @Idempotent()
  @ApiOperation({
    summary: 'Ask to read a private thread',
    description:
      'Returns `{ grantId, expiresAt }`. The grant lasts **30 minutes**, for this staff member ' +
      'and this conversation only, and `GET` the thread or its messages with it in the ' +
      '`X-Thread-Access-Grant` header — without one, 403 `THREAD_ACCESS_REQUIRED`.\n\n' +
      '`messages:read` lets you list which conversations a member has (§5.4). Reading the words ' +
      'in one needs a reason, and the reason has to be a record somebody can open afterwards: ' +
      '`linkedType` + `linkedId`, which must exist, be visible to you under your own ' +
      'permissions, and involve somebody in the conversation — otherwise 422 `LINK_REQUIRED`. ' +
      'Free text is never accepted. `admin/members/:id/linkable-cases` is the list of what you ' +
      'may link to.\n\n' +
      'A support thread or a Guard case is 409 `USE_SUPPORT_INBOX` with `data.redirect`: those ' +
      'are read through §5.15 and §5.12, which gate on `support:read` and `guard:read`.\n\n' +
      'Reading changes nothing the member can see — no participant row, no read receipt, no ' +
      'unread count (S9.4) — and every page read writes an audit entry naming the grant and the ' +
      'messages it covered.',
  })
  async grantAccess(
    @CurrentUser() actor: AdminPrincipal,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: GrantThreadAccessDto,
  ) {
    return {
      data: await this.access.grant(actor, conversationId, dto),
      message: 'Access granted and recorded.',
    };
  }

  @Get('threads/:conversationId')
  @AdminPermissions('messages:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'What the thread is, and what it is about',
    description:
      'Participants with their role, the context the thread hangs off, and the reports filed ' +
      'about it or about a message in it — never who filed them (R9 keys that on ' +
      '`moderation:read`).\n\n' +
      'Needs the grant header, and is audited like a page of messages: opening a thread is ' +
      'reading it.',
  })
  async threadHeader(
    @CurrentUser() actor: AdminPrincipal,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Headers(THREAD_ACCESS_HEADER) grantId: string,
  ) {
    return {
      data: await this.access.header(actor, conversationId, grantId),
      message: SuccessMessage.RESOURCE_FETCHED('Thread'),
    };
  }

  @Get('threads/:conversationId/messages')
  @AdminPermissions('messages:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The messages, newest first',
    description:
      'Cursor paging, not pages: a thread is read newest-first and grows while it is open, so an ' +
      'offset into it means something different by the time it is used. Send ' +
      '`meta.nextBefore` back as `before`.\n\n' +
      '`accessLogged: true` is there for the banner the portal keeps up while somebody is inside ' +
      'a recorded read, and `expiresAt` is when it stops. A withdrawn message is a tombstone — ' +
      '`deleted: true`, no body (S9.5).',
  })
  async threadMessages(
    @CurrentUser() actor: AdminPrincipal,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Headers(THREAD_ACCESS_HEADER) grantId: string,
    @Query() query: ListMessagesDto,
  ) {
    const { data, meta } = await this.access.messages(actor, conversationId, grantId, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Messages') };
  }

  @Get('guard/cases/:id/messages')
  @AdminPermissions('guard:read')
  @ApiOperation({
    summary: 'Read a Guard case thread',
    description:
      'Needs `guard:read`, which is held by fewer people than `moderation:read` on purpose: a ' +
      'member disclosing abuse is a different job from triaging spam.',
  })
  async guardMessages(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListMessagesDto,
  ) {
    const conversationId = await this.guardConversation(id);

    // §4.8's badge, cleared from here as well as from the inbox. A Guard case is readable through
    // two doors — this one, addressed by the case, and §5.15's, addressed by the conversation —
    // and a thread read through this one would otherwise keep telling the inbox it was unread.
    await this.database.supportThread.updateMany({
      where: { conversationId, unreadForStaff: { gt: 0 } },
      data: { unreadForStaff: 0 },
    });

    // Not `history`: that requires being a participant of the thread, which for a Guard case is
    // the assignee alone. R7 grants reading to anybody holding `guard:read`, and it has to —
    // a case whose assignee is away must still be readable by their colleagues.
    const result = await this.messages.pageWithoutAuthorisation(actor.id, conversationId, query);
    const participants = await this.database.conversationParticipant.findMany({
      where: { conversationId },
      select: { userId: true, role: true },
    });
    const roles = new Map(participants.map(row => [row.userId, row.role]));

    // Reading somebody's private disclosure is an act, and an act that leaves no trace is one
    // nobody can be asked about. But the portal polls this every thirty seconds, so one entry per
    // request is thousands a day per staff member per case — a trail in which every genuine act is
    // buried, which is the same as not having one. §5.12: once per staff member per case per day.
    await this.audit.noteOncePer(
      `audit:guard-read:${actor.id}:${id}:${new Date().toISOString().slice(0, 10)}`,
      THREAD_READ_WINDOW_SECONDS,
      {
        action: 'guard.thread_read',
        targetType: 'CONVERSATION',
        targetId: conversationId,
        metadata: { guardThreadId: id, messages: result.data?.length ?? 0 },
      },
    );

    // §5.12's shape, the same one the support inbox serves: `{ messages: [...] }`, oldest first,
    // with a `role` on each sender so a colleague's reply is not guessed at by elimination.
    return {
      data: { messages: toAdminMessages(result.data ?? [], roles) },
      meta: result.meta,
      message: SuccessMessage.RESOURCE_FETCHED('Messages'),
    };
  }

  @Post('guard/cases/:id/messages')
  @AdminPermissions('guard:manage')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'Reply as the Circl team',
    description: 'The member sees a message from Circl in the thread they already have open.',
  })
  async guardReply(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendMessageDto,
  ) {
    const conversationId = await this.guardConversation(id);

    // Replying attaches them to the thread if they are not already on it.
    //
    // Sending requires participation, and for a Guard case that was the assignee alone — so an
    // unassigned case could not be answered by anybody, and a case whose assignee was away could
    // not be answered at all. Answering it is taking it, which is what a participant row says.
    // Reading, above, deliberately does not do this: reading somebody's disclosure must leave
    // nothing behind in their thread.
    await this.conversations.addStaff(conversationId, [actor.id]);

    const sent = await this.messages.send(actor.id, conversationId, dto);

    await this.audit.note({
      action: 'guard.replied',
      targetType: 'CONVERSATION',
      targetId: conversationId,
      metadata: { guardThreadId: id },
    });

    return { data: sent, message: 'Reply sent.' };
  }

  /** The Guard case's own conversation, which is what the member is actually reading. */
  private async guardConversation(guardThreadId: string): Promise<string> {
    const thread = await this.database.guardThread.findUnique({
      where: { id: guardThreadId },
      select: { conversationId: true },
    });

    if (!thread?.conversationId) throw ApiException.notFound('No such Guard case.');

    return thread.conversationId;
  }
}
