import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { CurrentUserId, Idempotent, JwtAuthGuard, RateLimit, SuccessMessage } from '@/common';
import {
  EditMessageDto,
  ListConversationsDto,
  ListMessagesDto,
  MarkReadDto,
  MuteDto,
  ReactDto,
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
  @ApiOperation({
    summary: 'Open a thread with a member, about something or about nothing',
    description:
      'Without `context`, a plain DM. With one, a thread pinned to the subject: an item somebody ' +
      'is asking about, or an offer. Those two are here because they are the only subjects a ' +
      'member starts a thread about before there is anything to create — every other ' +
      'subject-bearing thread comes back from the section that owns it (5.0, rule 3).\n\n' +
      '**Safe to call without checking first.** Threads are unique on (participants, contextType, ' +
      'contextId), so this returns the existing thread rather than a second one: `201` when it ' +
      'created the thread, `200` when it opened one that already existed.\n\n' +
      'With a `context`, `recipientUserId` is optional and derived from the subject.',
  })
  @ApiResponse({ status: 201, description: 'The thread did not exist and was created.' })
  @ApiResponse({ status: 200, description: 'A thread already matched, and this is it.' })
  @ApiResponse({
    status: 422,
    description: 'The recipient does not own the subject of the thread.',
  })
  async start(
    @CurrentUserId() userId: string,
    @Body() dto: StartThreadDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { conversation, created } = await this.conversations.startDirect(userId, dto);

    // 201 only when something was created. The client calls this every time it opens a chat
    // screen, and most of those are not creations (5.3.5).
    response.status(created ? HttpStatus.CREATED : HttpStatus.OK);

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

    // The delivery the socket path performs: `message.new`, a push to whoever is not connected,
    // and the sender's DELIVERED tick. A REST send must not wait on a refresh (5.2).
    await this.gateway.fanOut(id, data, userId);

    return { data, message: 'Message sent' };
  }

  @Patch(':conversationId/messages/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Edit a message',
    description:
      'Sender only, within the same fifteen minutes as withdrawing, text only — a photo or a ' +
      'voice note is withdrawn and sent again rather than edited. Past the window it is a ' +
      '`403 EDIT_WINDOW_CLOSED`, which the client can tell apart from a generic refusal. The ' +
      'payload comes back with `editedAt` set, which is what makes the bubble say "edited", and ' +
      '`?since=` already returns anything whose `editedAt` moved.',
  })
  async editMessage(
    @CurrentUserId() userId: string,
    @Param('conversationId') conversationId: string,
    @Param('id') id: string,
    @Body() dto: EditMessageDto,
  ) {
    const data = await this.messages.edit(userId, conversationId, id, dto.body);

    void this.gateway.broadcastMessageUpdated(conversationId, id, userId);

    return { data, message: 'Message updated' };
  }

  @Put(':conversationId/messages/:id/reactions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'React to a message',
    description:
      'One reaction per member per message, so this replaces any previous one — which is why it ' +
      'is a PUT. Answers the new aggregate rather than a row, because that is what the chips ' +
      'under a bubble read.',
  })
  @RateLimit('REACT')
  async react(
    @CurrentUserId() userId: string,
    @Param('conversationId') conversationId: string,
    @Param('id') id: string,
    @Body() dto: ReactDto,
  ) {
    const data = await this.messages.react(userId, conversationId, id, dto.emoji);

    void this.gateway.broadcastReaction(conversationId, id);

    return { data, message: 'Reaction saved' };
  }

  @Delete(':conversationId/messages/:id/reactions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Take a reaction back',
    description: 'Idempotent: removing one you never left answers the state you asked for.',
  })
  async unreact(
    @CurrentUserId() userId: string,
    @Param('conversationId') conversationId: string,
    @Param('id') id: string,
  ) {
    const data = await this.messages.unreact(userId, conversationId, id);

    void this.gateway.broadcastReaction(conversationId, id);

    return { data, message: 'Reaction removed' };
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
    description:
      'Notifications resume. The unread count was never affected: mute silences the push, not the count (5.4).',
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
