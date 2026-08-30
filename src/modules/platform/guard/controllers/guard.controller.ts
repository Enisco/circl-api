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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId, Idempotent, JwtAuthGuard, SuccessMessage } from '@/common';
import {
  CreateGuardRequestDto,
  CreateGuardThreadDto,
  ListGuardThreadsDto,
  ListSupportResourcesDto,
} from '../dtos/guard.dto';
import { GuardService } from '../services/guard.service';

@ApiBearerAuth()
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

  @Post('requests')
  @Idempotent()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'A private request to Circl',
    description:
      'What the private help composer posts, and where the PRIVATE_TO_CIRCL route out of 1.2.3 ' +
      'lands. Creates or reuses the member\'s SUPPORT conversation and posts the body as a ' +
      'message: one support thread per member, forever, so the team sees one history rather ' +
      'than fragments (D36). No response time is promised (D35).',
  })
  async createRequest(@CurrentUserId() userId: string, @Body() dto: CreateGuardRequestDto) {
    const { data } = await this.guard.createRequest(userId, dto);

    return { data, message: 'Sent to the Circl team' };
  }

  @Get('resources')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Crisis and advice lines',
    description:
      'Served from the API rather than shipped in the binary so a number that changes is fixed ' +
      'the same day. The client keeps its own list as the offline fallback and treats an empty ' +
      'array as a failure, so this never errors on an unknown country (D39). Crisis rows first.',
  })
  async resources(@Query() query: ListSupportResourcesDto) {
    return this.guard.resources(query.countryCode ?? 'GB');
  }

  @Get('threads')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'My private threads',
    description:
      'The member\'s own Guard threads. Nobody else can see them, including other members of any '+
      'group they share.',
  })
  async list(@CurrentUserId() userId: string, @Query() query: ListGuardThreadsDto) {
    const { data, meta } = await this.guard.listMine(userId, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Threads') };
  }

  @Get('threads/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'One private thread',
    description:
      'The member\'s own Guard thread, with its conversation id, so the client reopens the ' +
      'existing thread rather than starting a second (D36).',
  })
  async findOne(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.guard.findMine(userId, id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Thread') };
  }
}
