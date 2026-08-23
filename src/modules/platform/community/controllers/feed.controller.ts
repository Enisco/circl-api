import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId, JwtAuthGuard } from '@/common';
import { FeedQueryDto, LessLikeThisDto } from '../dtos/feed.dto';
import { FeedService } from '../services/feed.service';

@Controller('community/feed')
@ApiTags('Community · Feed')
@UseGuards(JwtAuthGuard)
export class FeedController {
  constructor(private readonly feed: FeedService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The merged, ranked community feed',
    description:
      'Requests, offers, updates and occasionally a guide, in one cursor-paged stream. Each item ' +
      'is a discriminated union on `type`. Personalised when the member has completed interests ' +
      'onboarding, and always switchable to LATEST.',
  })
  async list(@CurrentUserId() userId: string, @Query() query: FeedQueryDto) {
    return this.feed.feed(userId, query);
  }

  @Post(':itemId/less-like-this')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Show me less like this',
    description: 'The feed card overflow action. Suppresses the item and feeds the ranking model.',
  })
  async lessLikeThis(
    @CurrentUserId() userId: string,
    @Param('itemId') itemId: string,
    @Body() dto: LessLikeThisDto,
  ) {
    await this.feed.lessLikeThis(userId, itemId, dto);
  }
}
