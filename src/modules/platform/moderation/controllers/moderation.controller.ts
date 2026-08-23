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
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId, JwtAuthGuard, SuccessMessage } from '@/common';
import { CreateBlockDto, CreateReportDto, ListBlocksDto } from '../dtos/moderation.dto';
import { ModerationService } from '../services/moderation.service';

@Controller('moderation')
@ApiTags('Moderation')
@UseGuards(JwtAuthGuard)
export class ModerationController {
  constructor(private readonly moderation: ModerationService) {}

  @Post('reports')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Report content or a member',
    description:
      'Accepts a reportToken in place of an id for anonymous content. The response never reveals ' +
      'what happened to the reported content. SAFETY_CONCERN routes into Circl Guard rather than ' +
      'the standard moderation queue.',
  })
  async report(@CurrentUserId() userId: string, @Body() dto: CreateReportDto) {
    await this.moderation.report(userId, dto);

    return { data: null, message: 'Thanks. Our team will review this.' };
  }

  @Post('blocks')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Block a member',
    description:
      'Symmetric in effect: neither party sees the other in feeds, lists or search, and neither ' +
      'can message the other. Accepts a reportToken, so someone being harassed anonymously can ' +
      'block rather than only report.',
  })
  async block(@CurrentUserId() userId: string, @Body() dto: CreateBlockDto) {
    await this.moderation.block(userId, dto);

    return { data: null, message: 'Blocked' };
  }

  @Delete('blocks/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unblock a member' })
  async unblock(@CurrentUserId() blockerId: string, @Param('userId') blockedId: string) {
    await this.moderation.unblock(blockerId, blockedId);
  }

  @Get('blocks')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'The blocked list', description: 'For the settings screen.' })
  async listBlocks(@CurrentUserId() userId: string, @Query() query: ListBlocksDto) {
    const { data, meta } = await this.moderation.listBlocks(userId, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Blocked members') };
  }
}
