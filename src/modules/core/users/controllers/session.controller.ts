import { Controller, Delete, Get, HttpCode, HttpStatus, Param, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentSessionId, CurrentUserId, JwtAuthGuard, SuccessMessage } from '@/common';
import { SessionListService } from '../services/session-list.service';

/** The Security screen's device list (G3). */
@Controller('me/sessions')
@ApiTags('Users')
@UseGuards(JwtAuthGuard)
export class SessionController {
  constructor(private readonly sessions: SessionListService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Devices signed into this account',
    description:
      'Real sessions, so "sign out everywhere" ejects a device rather than filtering a local list.',
  })
  async list(@CurrentUserId() userId: string, @CurrentSessionId() sessionId: string | null) {
    const { data } = await this.sessions.list(userId, sessionId);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Sessions') };
  }

  @Delete(':sessionId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign one device out',
    description:
      'Refuses the caller\'s own session with 409: Log out is the path for that, so the app can ' +
      'clear the keychain in the same step.',
  })
  async revoke(
    @CurrentUserId() userId: string,
    @CurrentSessionId() currentSessionId: string | null,
    @Param('sessionId') sessionId: string,
  ) {
    const { data } = await this.sessions.revoke(userId, sessionId, currentSessionId);

    return { data, message: 'Signed out on that device' };
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign out everywhere except this device' })
  async revokeOthers(
    @CurrentUserId() userId: string,
    @CurrentSessionId() sessionId: string | null,
  ) {
    const { data } = await this.sessions.revokeOthers(userId, sessionId);

    return { data, message: 'Signed out everywhere else' };
  }
}
