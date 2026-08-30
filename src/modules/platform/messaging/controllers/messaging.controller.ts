import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId, Idempotent, JwtAuthGuard, RateLimit, SuccessMessage } from '@/common';
import {
  ListConversationsDto,
  ListMessagesDto,
  MarkReadDto,
  MuteDto,
  SendMessageDto,
  StartThreadDto,
} from '../dtos/message.dto';
import { ChatGateway } from '../gateway/chat.gateway';
import { ConversationService } from '../services/conversation.service';
import { MessageService } from '../services/message.service';

@ApiBearerAuth()
@Controller('messages')
@ApiTags('Messaging')
@UseGuards(JwtAuthGuard)
export class MessagingController {
  constructor(
    private readonly conversations: ConversationService,
    private readonly messages: MessageService,
    private readonly gateway: ChatGateway,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The inbox',
    description:
      'One inbox, five contexts — not one inbox per section. Pinned first, then recency, with ' +
      'pinning decided server-side so the support thread is first for everyone. `meta` carries ' +
      'unreadTotal and unreadThreads, because the badge is in four section headers and ' +
      'recomputing it from a page of this list is wrong the moment the list is filtered.',
  })
  async list(@CurrentUserId() userId: string, @Query() query: ListConversationsDto) {
    const { data, meta } = await this.conversations.list(userId, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Conversations') };
  }

  @Post()
  @Idempotent()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Start a plain direct message',
    description:
      'ONLY for a thread with no subject. Every subject-bearing thread is created by the section ' +
      'that owns the subject and returns its id — nothing in the app constructs a thread id. ' +
      'Returns the existing conversation when one already matches.',
  })
  async start(@CurrentUserId() userId: string, @Body() dto: StartThreadDto) {
    const { conversation, created } = await this.conversations.startDirect(userId, dto);

    return {
      data: conversation,
      message: created ? 'Conversation started' : 'Conversation opened',
    };
  }

  @Get('unread')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The account-wide unread badge',
    description: 'The REST equivalent of the socket `unread.total` event.',
  })
  async unread(@CurrentUserId() userId: string) {
    const data = await this.conversations.unreadTotal(userId);

    return { data, message: 'Unread counts loaded' };
  }

  @Get(':conversationId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'One conversation without its messages',
    description: 'For a deep link, when the inbox has not been loaded.',
  })
  async findOne(@CurrentUserId() userId: string, @Param('conversationId') id: string) {
    const data = await this.conversations.findOne(userId, id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Conversation') };
  }

  @Get(':conversationId/messages')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Message history',
    description:
      'Newest first, cursor-paged. A chat scrolls backwards, so page numbers over a list that ' +
      'grows at the head skip and repeat. `after` reads forwards, which is what the socket `sync` ' +
      'uses after a reconnect. A deleted message is a tombstone, not a gap.',
  })
  async history(
    @CurrentUserId() userId: string,
    @Param('conversationId') id: string,
    @Query() query: ListMessagesDto,
  ) {
    const { data, meta } = await this.messages.history(userId, id, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Messages') };
  }

  @Post(':conversationId/messages')
  @RateLimit('MESSAGE_MINUTE', 'MESSAGE_HOUR')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Send a message (REST fallback)',
    description:
      'The socket is the primary path; this exists for a client that cannot hold a connection. ' +
      'Both call the same service, so there is one writer and the two cannot drift. Replaying a ' +
      'clientId returns the original message rather than a duplicate.',
  })
  async send(
    @CurrentUserId() userId: string,
    @Param('conversationId') id: string,
    @Body() dto: SendMessageDto,
  ) {
    const data = await this.messages.send(userId, id, dto);

    // The same delivery the socket path performs: message.new to whoever is connected, a push to
    // whoever is not, and the sender's DELIVERED tick. Sending over REST must not mean the
    // recipient sees nothing until they refresh (5.2).
    await this.gateway.fanOut(id, data, userId);

    return { data, message: 'Message sent' };
  }

  @Delete(':conversationId/messages/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a message',
    description: 'Sender only, within 15 minutes. Tombstoned rather than removed.',
  })
  async removeMessage(
    @CurrentUserId() userId: string,
    @Param('conversationId') conversationId: string,
    @Param('id') id: string,
  ) {
    const data = await this.messages.remove(userId, conversationId, id);

    return { data, message: SuccessMessage.RESOURCE_DELETED('Message') };
  }

  @Post(':conversationId/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark read up to a message',
    description:
      'One call clears a backlog rather than one per message. Opening a thread reads it — a badge ' +
      'that survives opening the screen is the one people complain about.',
  })
  async markRead(
    @CurrentUserId() userId: string,
    @Param('conversationId') id: string,
    @Body() dto: MarkReadDto,
  ) {
    const data = await this.messages.markRead(userId, id, dto.lastReadMessageId);

    return { data, message: 'Marked as read' };
  }

  @Post(':conversationId/mute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mute a thread',
    description:
      'Silences the notification, not the count. A muted thread still increments unread.',
  })
  async mute(
    @CurrentUserId() userId: string,
    @Param('conversationId') id: string,
    @Body() dto: MuteDto,
  ) {
    const data = await this.conversations.setMuted(userId, id, true, dto.until);

    void this.gateway.pushConversationUpdated(userId, id);

    return { data, message: 'Thread muted' };
  }

  @Delete(':conversationId/mute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Unmute a thread',
    description: 'Notifications resume. The unread count was never affected: mute silences the push, not the count (5.4).',
  })
  async unmute(@CurrentUserId() userId: string, @Param('conversationId') id: string) {
    const data = await this.conversations.setMuted(userId, id, false);

    void this.gateway.pushConversationUpdated(userId, id);

    return { data, message: 'Thread unmuted' };
  }

  @Post(':conversationId/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Archive a thread',
    description:
      'Out of the inbox, not deleted. There is no "delete conversation": a deleted thread is a ' +
      'deleted record of an agreement.',
  })
  async archive(@CurrentUserId() userId: string, @Param('conversationId') id: string) {
    const data = await this.conversations.setArchived(userId, id, true);

    void this.gateway.pushConversationUpdated(userId, id);

    return { data, message: 'Thread archived' };
  }

  @Delete(':conversationId/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Unarchive a thread',
    description: 'Returns the conversation to the inbox. Archiving deleted nothing.',
  })
  async unarchive(@CurrentUserId() userId: string, @Param('conversationId') id: string) {
    const data = await this.conversations.setArchived(userId, id, false);

    void this.gateway.pushConversationUpdated(userId, id);

    return { data, message: 'Thread restored' };
  }
}
