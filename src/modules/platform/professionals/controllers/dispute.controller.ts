import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId, Idempotent, JwtAuthGuard, SuccessMessage } from '@/common';
import { DisputeEvidenceDto, OpenDisputeDto } from '../dtos/booking.dto';
import { DisputeService } from '../services/dispute.service';

/**
 * The shared dispute resource (2.10, 4.1.3).
 *
 * One endpoint with a polymorphic subject rather than two near-identical ones,
 * so "Report a problem" behaves the same whichever half of the app you raise it
 * from. `POST /bookings/{id}/disputes` stays because 2.10 names it, and both
 * paths run the same service.
 */
@Controller('disputes')
@ApiTags('Disputes')
@UseGuards(JwtAuthGuard)
export class DisputeController {
  constructor(private readonly disputes: DisputeService) {}

  @Post()
  @Idempotent()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Raise an issue on a booking or an order',
    description:
      'Pauses the work and adds Circl staff to the EXISTING thread rather than opening a new one, ' +
      'so the two parties keep their history and the team gains the context. Nothing is frozen, ' +
      'because Circl holds nothing — the honest phrasing is that the job is paused and Circl ' +
      'reviews it. A second attempt returns 409 with the open dispute.',
  })
  async open(@CurrentUserId() userId: string, @Body() dto: OpenDisputeDto) {
    const payload = {
      reasonCode: dto.reasonCode,
      description: dto.description,
      mediaIds: dto.mediaIds,
    };

    const data =
      dto.subjectType === 'BOOKING'
        ? await this.disputes.openForBooking(userId, dto.subjectId, payload)
        : await this.disputes.openForEnquiry(userId, dto.subjectId, payload);

    return { data, message: 'Issue raised' };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'One dispute, with the evidence both sides have added' })
  async findOne(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.disputes.findOne(userId, id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Issue') };
  }

  @Post(':id/evidence')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Add evidence to an open dispute',
    description:
      'The screen promises "Both of you can add evidence", so it has to be true after submission ' +
      'and not only during it. Either party may add, until the dispute is resolved or withdrawn.',
  })
  async addEvidence(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: DisputeEvidenceDto,
  ) {
    const data = await this.disputes.addEvidence(userId, id, dto);

    return { data, message: 'Evidence added' };
  }
}
