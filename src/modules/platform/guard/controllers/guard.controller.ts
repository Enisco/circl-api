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
import { CurrentUserId, Idempotent, JwtAuthGuard, SuccessMessage } from '@/common';
import { CreateGuardThreadDto, ListGuardThreadsDto } from '../dtos/guard.dto';
import { GuardService } from '../services/guard.service';

@Controller('guard')
@ApiTags('Circl Guard')
@UseGuards(JwtAuthGuard)
export class GuardController {
  constructor(private readonly guard: GuardService) {}

  @Post('threads')
  @Idempotent()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Private to Circl',
    description:
      "Opens a private thread with Circl's team. Invisible to the community, and it creates no " +
      'public post of any kind. No response time is promised: the opening system message says what ' +
      'the channel is and who can see it, and commits to no timeframe. Returns the conversationId, ' +
      'so the member continues in the ordinary chat.',
  })
  async create(@CurrentUserId() userId: string, @Body() dto: CreateGuardThreadDto) {
    const data = await this.guard.createThread(userId, dto);

    return { data, message: 'Sent to the Circl team' };
  }

  @Get('threads')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'My private threads' })
  async list(@CurrentUserId() userId: string, @Query() query: ListGuardThreadsDto) {
    const { data, meta } = await this.guard.listMine(userId, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Threads') };
  }

  @Get('threads/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'One private thread' })
  async findOne(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.guard.findMine(userId, id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Thread') };
  }
}
