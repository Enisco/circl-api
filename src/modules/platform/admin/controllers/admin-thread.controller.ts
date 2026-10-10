import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ThreadContextType } from '@prisma/client';
import { AdminJwtGuard } from '@/common/guards/admin-jwt.guard';
import { ApiErrorCode, ApiException, CurrentUser, RateLimit, SuccessMessage } from '@/common';
import { PrismaService } from '@/infrastructure';
import { MessageService } from '../../messaging/services/message.service';
import { ListMessagesDto, SendMessageDto } from '../../messaging/dtos/message.dto';
import { AdminBffGuard } from '../common/admin-bff.guard';
import { AdminPermissionGuard } from '../common/admin-permission.guard';
import { AdminPermissions, AdminPrincipal } from '../common/admin-principal';
import { AuditService } from '../audit/audit.service';

/**
 * Staff replies in Guard cases and support threads.
 *
 * Here because member authentication now refuses staff accounts, and staff used to reply by
 * signing in to the app — which was the hole: a staff inbox was an administrator login (B1). The
 * reply itself still goes through the ordinary message service, so a member sees what they always
 * saw: a message from the Circl team in the thread they already have open.
 *
 * Minimal on purpose. The full inbox — assignment, states, canned replies, the thread viewer —
 * arrives with the support milestone. This is the part that cannot wait, because without it
 * closing the hole would also stop staff answering a safeguarding disclosure.
 */
@ApiExcludeController()
@ApiTags('Admin · Threads')
@Controller('admin')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminThreadController {
  constructor(
    private readonly database: PrismaService,
    private readonly messages: MessageService,
    private readonly audit: AuditService,
  ) {}

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
    const result = await this.messages.history(actor.id, conversationId, query);

    // One entry per page read, naming the conversation. Reading somebody's private disclosure is
    // an act, and an act that leaves no trace is one nobody can be asked about.
    await this.audit.note({
      action: 'thread.read',
      targetType: 'CONVERSATION',
      targetId: conversationId,
      metadata: { guardThreadId: id, messages: result.data?.length ?? 0 },
    });

    return { ...result, message: SuccessMessage.RESOURCE_FETCHED('Messages') };
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
    const sent = await this.messages.send(actor.id, conversationId, dto);

    await this.audit.note({
      action: 'guard.replied',
      targetType: 'CONVERSATION',
      targetId: conversationId,
      metadata: { guardThreadId: id },
    });

    return { data: sent, message: 'Reply sent.' };
  }

  @Get('support/threads/:conversationId/messages')
  @AdminPermissions('support:read')
  @ApiOperation({ summary: 'Read a support thread' })
  async supportMessages(
    @CurrentUser() actor: AdminPrincipal,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Query() query: ListMessagesDto,
  ) {
    await this.assertSupportThread(conversationId);

    const result = await this.messages.history(actor.id, conversationId, query);

    await this.audit.note({
      action: 'thread.read',
      targetType: 'CONVERSATION',
      targetId: conversationId,
      metadata: { messages: result.data?.length ?? 0 },
    });

    return { ...result, message: SuccessMessage.RESOURCE_FETCHED('Messages') };
  }

  @Post('support/threads/:conversationId/messages')
  @AdminPermissions('support:manage')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({ summary: 'Reply in a support thread as the Circl team' })
  async supportReply(
    @CurrentUser() actor: AdminPrincipal,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: SendMessageDto,
  ) {
    await this.assertSupportThread(conversationId);

    const sent = await this.messages.send(actor.id, conversationId, dto);

    await this.audit.note({
      action: 'support.replied',
      targetType: 'CONVERSATION',
      targetId: conversationId,
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

  /**
   * Refuses anything that is not a support thread.
   *
   * Without it this endpoint would read any conversation by id, which is what the thread access
   * grant exists to prevent — a staff member could read two members' private messages to each
   * other by guessing nothing more than a uuid.
   */
  private async assertSupportThread(conversationId: string): Promise<void> {
    const conversation = await this.database.conversation.findUnique({
      where: { id: conversationId },
      select: { contextType: true },
    });

    if (!conversation) throw ApiException.notFound('No such thread.');

    if (conversation.contextType !== ThreadContextType.SUPPORT) {
      throw ApiException.forbidden(
        ApiErrorCode.THREAD_ACCESS_REQUIRED,
        'That is a member conversation. Reading it needs an access grant with a reason.',
      );
    }
  }
}
