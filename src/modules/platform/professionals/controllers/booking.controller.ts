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
import {
  CancelDto,
  CreateBookingDto,
  CreateDisputeDto,
  DeliverDto,
  ListBookingsDto,
  RequestChangesDto,
  TransitionReasonDto,
} from '../dtos/booking.dto';
import { BookingService } from '../services/booking.service';
import { DisputeService } from '../services/dispute.service';

@Controller('bookings')
@ApiTags('Professionals · Bookings')
@UseGuards(JwtAuthGuard)
export class BookingController {
  constructor(
    private readonly bookings: BookingService,
    private readonly disputes: DisputeService,
  ) {}

  @Post()
  @Idempotent()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Book a service',
    description:
      'Send `serviceId` or `briefId`, never the values behind them — the server copies name, ' +
      'description and price across so a later edit to the listing cannot rewrite what was agreed. ' +
      'Creates the conversation and returns its id.',
  })
  async create(@CurrentUserId() userId: string, @Body() dto: CreateBookingDto) {
    const data = await this.bookings.create(userId, dto);

    return { data, message: SuccessMessage.RESOURCE_CREATED('Booking') };
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'My bookings',
    description:
      '`needsYourAction` is sent per booking so the "Needs you" group and the notification badge ' +
      'cannot disagree. `role=PROFESSIONAL` requires a listing.',
  })
  async list(@CurrentUserId() userId: string, @Query() query: ListBookingsDto) {
    const { data, meta } = await this.bookings.list(userId, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Bookings') };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Booking detail',
    description:
      'Every action button is server-authorised in `viewer`. The client renders exactly the ' +
      'actions that are true, so a policy change never needs an app release.',
  })
  async findOne(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.bookings.findOne(userId, id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Booking') };
  }

  // ─── Transitions (2.9.5) ───────────────────────────────────────────────────
  // Every one returns the full updated booking with its new timeline and viewer, so the screen never needs a follow-up fetch.

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept a booking',
    description: 'Professional, from PENDING_ACCEPTANCE.',
  })
  async accept(@CurrentUserId() userId: string, @Param('id') id: string) {
    return { data: await this.bookings.accept(userId, id), message: 'Booking accepted' };
  }

  @Post(':id/decline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Decline a booking' })
  async decline(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: TransitionReasonDto,
  ) {
    return { data: await this.bookings.decline(userId, id, dto), message: 'Booking declined' };
  }

  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start work' })
  async start(@CurrentUserId() userId: string, @Param('id') id: string) {
    return { data: await this.bookings.start(userId, id), message: 'Work started' };
  }

  @Post(':id/deliver')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark as delivered',
    description: 'Stamps `autoCompleteAt` 7 days out, which the screen can then state plainly.',
  })
  async deliver(@CurrentUserId() userId: string, @Param('id') id: string, @Body() dto: DeliverDto) {
    return { data: await this.bookings.deliver(userId, id, dto), message: 'Marked as delivered' };
  }

  @Post(':id/request-changes')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ask for changes',
    description: 'Client, from DELIVERED. Work resumes.',
  })
  async requestChanges(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: RequestChangesDto,
  ) {
    return {
      data: await this.bookings.requestChanges(userId, id, dto),
      message: 'Changes requested',
    };
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm the job is done',
    description: 'Closes the job and opens reviews. No payment occurs.',
  })
  async complete(@CurrentUserId() userId: string, @Param('id') id: string) {
    return { data: await this.bookings.complete(userId, id), message: 'Booking completed' };
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel', description: 'Either party, before work starts.' })
  async cancel(@CurrentUserId() userId: string, @Param('id') id: string, @Body() dto: CancelDto) {
    return { data: await this.bookings.cancel(userId, id, dto), message: 'Booking cancelled' };
  }

  // ─── Disputes (2.10) ───────────────────────────────────────────────────────

  @Post(':id/disputes')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Raise an issue',
    description:
      'Pauses the job and adds Circl staff to the existing thread rather than opening a new one. ' +
      'Nothing is frozen, because Circl holds nothing.',
  })
  async raiseDispute(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: CreateDisputeDto,
  ) {
    const data = await this.disputes.openForBooking(userId, id, dto);

    return { data, message: 'Issue raised' };
  }
}
