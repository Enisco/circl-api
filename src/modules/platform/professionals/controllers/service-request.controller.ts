import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId, Idempotent, JwtAuthGuard, RateLimit, SuccessMessage } from '@/common';
import { CreateServiceRequestDto } from '../dtos/service-request.dto';
import { ServiceRequestService } from '../services/service-request.service';

/**
 * "Let Circl handle it" — the member's side.
 *
 * Somebody needs a professional and cannot tell which one. Browsing assumes you know what you are
 * looking for; this assumes you do not. A member describes the problem, a person at Circl reads it
 * and offers it to professionals they judge suitable, and up to three of them introduce
 * themselves. Nothing here scores or ranks anybody — the value is that a human did the thinking.
 */
@ApiBearerAuth()
@Controller('professionals/service-requests')
@ApiTags('Professionals · Circl Handle It')
@UseGuards(JwtAuthGuard)
export class ServiceRequestController {
  constructor(private readonly requests: ServiceRequestService) {}

  @Post()
  @Idempotent()
  @RateLimit('CREATE')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Describe the problem',
    description:
      '`description` is the only required field. A missing `categoryCode` is the member saying ' +
      'they do not know what they need, which is the reason this route exists: it is never ' +
      'defaulted and never rejected.\n\n' +
      'The city is taken from the member’s profile — there is no city picker on this screen, and ' +
      'staff need it to search.\n\n' +
      'Send `budget` only for a single figure in pence. Anything else — a range, "Flexible", ' +
      '"about £75" — goes in `budgetText` and is shown to staff exactly as typed.\n\n' +
      'There is no cap on how many a member may have open; the limit is 20 an hour.',
  })
  async create(@CurrentUserId() userId: string, @Body() dto: CreateServiceRequestDto) {
    const data = await this.requests.create(userId, dto);

    return { data, message: 'A person at Circl will read this' };
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Their own requests, newest first',
    description:
      'Each carries `status`, Circl’s own `note`, and `responders` — whoever has taken it on, ' +
      'with the conversation already open. Never how many professionals were asked.',
  })
  async list(@CurrentUserId() userId: string) {
    const data = await this.requests.list(userId);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Requests') };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'One request',
    description:
      '`SUBMITTED` means nobody has read it yet and `MATCHING` means offers are out — two ' +
      'different promises, which is why they are two statuses rather than one.',
  })
  async findOne(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.requests.findOne(userId, id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Request') };
  }

  @Post(':id/cancel')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Withdraw it',
    description:
      'Allowed while `SUBMITTED` or `MATCHING`, and a 409 `INVALID_TRANSITION` after that: once ' +
      'somebody has written to you it is a conversation, and that is ended by leaving it.\n\n' +
      'Any offer still waiting for an answer is revoked in the same breath — a withdrawn request ' +
      'sitting in a professional’s inbox is work they can accept and nobody will honour.',
  })
  async cancel(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.requests.cancel(userId, id);

    return { data, message: 'Request withdrawn' };
  }
}
