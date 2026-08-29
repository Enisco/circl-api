import { Body, Controller, Get, HttpCode, HttpStatus, Put, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId, JwtAuthGuard } from '@/common';
import { NotificationPreferenceService } from '../services';
import { UpdatePreferencesDto } from '../dtos';

@Controller('users/notification-preferences')
@ApiTags('Notifications')
@UseGuards(JwtAuthGuard)
export class NotificationPreferenceController {
  constructor(private readonly preferences: NotificationPreferenceService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The preference matrix',
    description:
      'One row per category, two channels. `label` is required and rendered verbatim, and the ' +
      'rows arrive in the order the screen should draw them (D38).',
  })
  async get(@CurrentUserId() userId: string) {
    return this.preferences.matrix(userId);
  }

  @Put()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Save the matrix',
    description:
      'Takes the code and the two booleans, never `label` or `isLocked`. A change to a locked ' +
      'category is rejected with 422 PREFERENCE_LOCKED rather than silently ignored, so the ' +
      'client can put back the toggle it drew optimistically. Returns the full saved matrix.',
  })
  async update(@CurrentUserId() userId: string, @Body() dto: UpdatePreferencesDto) {
    return this.preferences.update(userId, dto);
  }
}
