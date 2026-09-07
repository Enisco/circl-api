import { Controller, Get, HttpCode, HttpStatus, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId, JwtAuthGuard, SuccessMessage } from '@/common';
import { PresenceDto, PresenceQueryDto } from '../dtos/presence.dto';
import { PresenceService } from '../services/presence.service';

/** Who is online, for the dot beside a name (5.2). */
@ApiBearerAuth()
@Controller('presence')
@ApiTags('Messaging')
@UseGuards(JwtAuthGuard)
export class PresenceController {
  constructor(private readonly presence: PresenceService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Who of these members is online',
    description:
      'One call for a screen full of people: an inbox page, a group member list, a search result.\n\n' +
      '**Online means a live socket**, nothing softer. A member with the app in the background and ' +
      'a valid token is offline, because that is what the person on the other end of the chat ' +
      'actually experiences.\n\n' +
      'Every id asked about comes back, in the order asked, so the client can zip the result ' +
      'against its own list. An id that is blocked, deleted or unknown comes back offline with a ' +
      'null `lastSeenAt` rather than an error: the caller has no business knowing which it was.\n\n' +
      '**Prefer the socket for keeping it fresh.** This endpoint answers "what is true now"; the ' +
      '`presence` event tells you when it changes, and polling it on a timer is the thing not to do.',
  })
  @ApiOkResponse({ type: [PresenceDto] })
  async many(@CurrentUserId() userId: string, @Query() query: PresenceQueryDto) {
    const data = await this.presence.of(userId, query.userIds);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Presence') };
  }

  @Get(':userId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Whether one member is online',
    description: 'The single-member case, for a profile screen. Same rules as the batch call.',
  })
  @ApiOkResponse({ type: PresenceDto })
  async one(@CurrentUserId() viewerId: string, @Param('userId') userId: string) {
    const data = await this.presence.one(viewerId, userId);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Presence') };
  }
}
