import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId, Idempotent, JwtAuthGuard, SuccessMessage, RateLimit } from '@/common';
import {
  CreateRequestDto,
  ListRequestsDto,
  ResolveRequestDto,
  UpdateRequestDto,
} from '../dtos/request.dto';
import { CreateResponseDto, ListResponsesDto } from '../dtos/response.dto';
import { RequestService } from '../services/request.service';
import { RequestResponseService } from '../services/request-response.service';

@ApiBearerAuth()
@Controller('community/requests')
@ApiTags('Community · Requests')
@UseGuards(JwtAuthGuard)
export class RequestController {
  constructor(
    private readonly requests: RequestService,
    private readonly responses: RequestResponseService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List community requests',
    description:
      'Backs both the "Requests near you" strip on the Feed tab and the full list with its ' +
      'All / Open / Closed filter.',
  })
  async list(@CurrentUserId() userId: string, @Query() query: ListRequestsDto) {
    const { data, meta } = await this.requests.list(userId, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Requests') };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request detail',
    description:
      'The full record. The response thread is a separate paginated call, because a busy request ' +
      'can carry dozens of replies. Viewing counts a view, deduplicated per member per day.',
  })
  async findOne(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.requests.findOne(userId, id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Request') };
  }

  @Post()
  @Idempotent()
  @RateLimit('CREATE')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Post a request',
    description:
      'The "I need help" composer. Send an Idempotency-Key: the composer posts optimistically and ' +
      'retries, and a duplicate in the feed is a visible embarrassment.',
  })
  async create(@CurrentUserId() userId: string, @Body() dto: CreateRequestDto) {
    const data = await this.requests.create(userId, dto);

    return { data, message: SuccessMessage.RESOURCE_CREATED('Request') };
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Edit a request', description: 'Owner only, and only while OPEN.' })
  async update(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateRequestDto,
  ) {
    const data = await this.requests.update(userId, id, dto);

    return { data, message: SuccessMessage.RESOURCE_UPDATED('Request') };
  }

  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark resolved and credit helpers',
    description:
      'The only place a community review becomes possible, so it is what carries a reputation ' +
      'earned here into Professionals, Connect and Commerce.',
  })
  async resolve(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: ResolveRequestDto,
  ) {
    const data = await this.requests.resolve(userId, id, dto);

    return { data, message: 'Request resolved' };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a request',
    description: 'Soft delete; a later GET tombstones.',
  })
  async remove(@CurrentUserId() userId: string, @Param('id') id: string) {
    await this.requests.remove(userId, id);
  }

  // ─── Responses (1.3) ───────────────────────────────────────────────────────

  @Get(':id/responses')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The response thread',
    description:
      'Private responses are returned only to the request owner and their author, and are ' +
      'excluded from totalCount for everyone else so the count matches what is on screen.',
  })
  async listResponses(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Query() query: ListResponsesDto,
  ) {
    const { data, meta } = await this.responses.list(userId, id, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Responses') };
  }

  @Post(':id/responses')
  @Idempotent()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Reply, or offer to help',
    description:
      'Both the "I can help" and "Just replying" modes post here; they differ only by isHelpOffer. ' +
      'Returns the updated parent counts so the client does not need a refetch.',
  })
  @RateLimit('CREATE')
  async createResponse(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: CreateResponseDto,
  ) {
    const data = await this.responses.create(userId, id, dto);

    return { data, message: 'Reply posted' };
  }

  @Delete(':requestId/responses/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a reply', description: 'Author or request owner.' })
  async removeResponse(
    @CurrentUserId() userId: string,
    @Param('requestId') requestId: string,
    @Param('id') id: string,
  ) {
    const requestCounts = await this.responses.remove(userId, requestId, id);

    return { data: { requestCounts }, message: SuccessMessage.RESOURCE_DELETED('Reply') };
  }
}
