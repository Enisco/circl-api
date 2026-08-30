import { Body, Controller, Get, HttpCode, HttpStatus, Patch, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUserId, JwtAuthGuard, SuccessMessage } from '@/common';
import { PrivacyService } from '../services/privacy.service';
import { UpdatePrivacyDto } from '../dtos/account.dto';
import { PrivacyResponseDto } from '../dtos/account-response.dto';

/** The Privacy screen's switches (G7). */
@ApiBearerAuth()
@Controller('users/me/privacy')
@ApiTags('Users')
@UseGuards(JwtAuthGuard)
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Privacy preferences',
    description:
      'The three switches on the Privacy screen. Defaults to all on, so a member who has never '+
      'opened the screen reads the same values the server applies.',
  })
    @ApiOkResponse({ type: PrivacyResponseDto })
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
    @ApiOkResponse({ type: PrivacyResponseDto })
  async update(@CurrentUserId() userId: string, @Body() dto: UpdatePrivacyDto) {
    const { data } = await this.privacy.update(userId, dto);

    return { data, message: SuccessMessage.RESOURCE_UPDATED('Privacy preferences') };
  }
}
