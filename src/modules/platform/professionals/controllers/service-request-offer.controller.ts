import { Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId, Idempotent, JwtAuthGuard, SuccessMessage } from '@/common';
import { ServiceRequestOfferService } from '../services/service-request-offer.service';

/**
 * Work Circl has offered this professional (§2, professional side).
 *
 * An offer, never an assignment: staff put a request in front of somebody they judged suitable,
 * and the professional decides. The member is not named on any of this — they agreed to hear from
 * professionals Circl chose, not to have their name circulated to everyone who was asked.
 */
@ApiBearerAuth()
@Controller('professionals/me/service-request-offers')
@ApiTags('Professionals · Circl Handle It')
@UseGuards(JwtAuthGuard)
export class ServiceRequestOfferController {
  constructor(private readonly offers: ServiceRequestOfferService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'What Circl has offered me',
    description:
      'Pending first, then answered — answered rows stay in the list, because one that vanishes ' +
      'on tap reads as a bug.\n\n' +
      '`REVOKED` is not `DECLINED`: it means Circl withdrew the offer, usually because three ' +
      'other professionals took the request on first.\n\n' +
      'The request carries its city and category but never the member: an offer is a question, ' +
      'and the member has not agreed to be introduced to everybody who was asked.',
  })
  async list(@CurrentUserId() userId: string) {
    const data = await this.offers.list(userId);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Offers') };
  }

  @Post(':id/accept')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Take it on',
    description:
      'Returns the offer with `conversationId` set. The thread exists by the time this responds ' +
      'and the introduction has already been posted in your name — the app should navigate ' +
      'straight into it rather than opening a thread itself.\n\n' +
      'Three acceptances is the cap. The fourth is a 409 `SERVICE_REQUEST_FILLED`, enforced ' +
      'under a row lock because two professionals answering in the same second is the ordinary ' +
      'case here. Accepting twice is not an error: the same offer comes back.',
  })
  async accept(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.offers.accept(userId, id);

    return { data, message: 'You have taken this on' };
  }

  @Post(':id/decline')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Not for me',
    description:
      'Nothing is held against a professional for declining, and the member is never told who ' +
      'was asked, so nothing about this reaches them.',
  })
  async decline(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.offers.decline(userId, id);

    return { data, message: 'Passed' };
  }
}
