import { Body, Controller, Get, HttpCode, HttpStatus, Patch, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId, JwtAuthGuard, SuccessMessage } from '@/common';
import { PrivacyService } from '../services/privacy.service';
import { UpdatePrivacyDto } from '../dtos/account.dto';

/** The Privacy screen's switches (G7). */
@Controller('users/me/privacy')
@ApiTags('Users')
@UseGuards(JwtAuthGuard)
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Privacy preferences' })
  async get(@CurrentUserId() userId: string) {
    const { data } = await this.privacy.get(userId);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Privacy preferences') };
  }

  @Patch()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update privacy preferences',
    description:
      'Accepts any subset and returns the whole object, the same contract the notification ' +
      'matrix uses. `personalisedFeed: false` really does fall the feed back to recency and city.',
  })
  async update(@CurrentUserId() userId: string, @Body() dto: UpdatePrivacyDto) {
    const { data } = await this.privacy.update(userId, dto);

    return { data, message: SuccessMessage.RESOURCE_UPDATED('Privacy preferences') };
  }
}
