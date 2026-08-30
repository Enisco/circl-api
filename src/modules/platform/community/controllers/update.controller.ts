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
import {
  CurrentUserId,
  Idempotent,
  JwtAuthGuard,
  PageOptionsDto,
  SuccessMessage,
  RateLimit,
} from '@/common';
import { CreateUpdateDto, CreateUpdateReplyDto, ListUpdatesDto } from '../dtos/update.dto';
import { UpdateService } from '../services/update.service';

@ApiBearerAuth()
@Controller('community/updates')
@ApiTags('Community · Updates')
@UseGuards(JwtAuthGuard)
export class UpdateController {
  constructor(private readonly updates: UpdateService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List updates',
    description: 'The community wall. Updates carry no category, so any category filter excludes them (1.1).',
  })
  async list(@CurrentUserId() userId: string, @Query() query: ListUpdatesDto) {
    const { data, meta } = await this.updates.list(userId, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Updates') };
  }

  @Post()
  @Idempotent()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Post an update',
    description:
      'A short post with no subject and no category. Media follows the standard rule: send keys, '+
      'read URLs (0.11).',
  })
  @RateLimit('CREATE')
  async create(@CurrentUserId() userId: string, @Body() dto: CreateUpdateDto) {
    const data = await this.updates.create(userId, dto);

    return { data, message: SuccessMessage.RESOURCE_CREATED('Post') };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update detail',
    description: 'One update with its reactions and reply count.',
  })
  async findOne(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.updates.findOne(userId, id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Post') };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete an update',
    description: 'Author only. Replies go with it, because a reply to nothing is not a record of anything.',
  })
  async remove(@CurrentUserId() userId: string, @Param('id') id: string) {
    await this.updates.remove(userId, id);
  }

  // ─── Reactions (1.5.3) ─────────────────────────────────────────────────────

  @Post(':id/reactions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Like an update',
    description:
      'Idempotent: liking twice is a no-op returning the current state, not a 409. Returns the ' +
      'authoritative count, because a client-side increment is wrong the moment a second device ' +
      'or another member touches the post.',
  })
  @RateLimit('REACT')
  async like(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.updates.react(userId, id, true);

    return { data, message: 'Reaction saved' };
  }

  @Delete(':id/reactions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove a like',
    description: 'Idempotent: removing a like that was never added succeeds.',
  })
  @RateLimit('REACT')
  async unlike(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.updates.react(userId, id, false);

    return { data, message: 'Reaction removed' };
  }

  // ─── Replies (1.5.4) ───────────────────────────────────────────────────────

  @Get(':id/replies')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Replies to an update', description: 'Oldest first. One level deep.' })
  async listReplies(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Query() query: PageOptionsDto,
  ) {
    const { data, meta } = await this.updates.listReplies(userId, id, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Replies') };
  }

  @Post(':id/replies')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Reply to an update',
    description: 'Replies are one level deep. There is no reply to a reply.',
  })
  @RateLimit('CREATE')
  async createReply(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: CreateUpdateReplyDto,
  ) {
    const data = await this.updates.createReply(userId, id, dto);

    return { data, message: 'Reply posted' };
  }

  @Delete(':updateId/replies/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a reply',
    description: 'Author only. Tombstoned rather than removed, so the thread does not renumber under a reader.',
  })
  async removeReply(
    @CurrentUserId() userId: string,
    @Param('updateId') updateId: string,
    @Param('id') id: string,
  ) {
    await this.updates.removeReply(userId, updateId, id);
  }
}
