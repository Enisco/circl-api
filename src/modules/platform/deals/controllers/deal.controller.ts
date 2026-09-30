import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentUserId, Idempotent, JwtAuthGuard, SuccessMessage } from '@/common';
import {
  CorrectAmountDto,
  DealTrackQueryDto,
  FlagProblemDto,
  MarkStepsDto,
  ProposeDealDto,
} from '../dtos/deal.dto';
import { DealService } from '../services/deal.service';

/**
 * A short list of steps two people tick off in their own thread, with the amount recorded when it
 * is paid.
 *
 * Circl takes no payment and cannot verify that any money moved: the whole feature is a shared
 * record between two people. Which is exactly why every rule is enforced here and not only in the
 * app — a client rule is a courtesy, and a timeline either side could write alone is worthless as
 * evidence.
 */
@ApiBearerAuth()
@Controller('deals')
@ApiTags('Deals')
@UseGuards(JwtAuthGuard)
export class DealController {
  constructor(private readonly deals: DealService) {}

  @Get('earnings')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirmed total and completions',
    description:
      'All-time, and **confirmed only**: an amount counts once the other side has marked the ' +
      'matching `PAYMENT_CONFIRMED` or `DEPOSIT_CONFIRMED`. A buyer saying they paid moves ' +
      'nothing, because a total built from unconfirmed claims is a wish-list.\n\n' +
      '`completed` counts deals that reached `DONE`. The average is left to the client to derive ' +
      'from the two, so the three numbers can never disagree with each other.\n\n' +
      'Owner-only, and `404` for a member with no shop (`COMMERCE`) or no listing ' +
      '(`PROFESSIONAL`) on this track.',
  })
  @ApiNotFoundResponse({ description: 'No shop or listing on this track.' })
  async earnings(@CurrentUserId() userId: string, @Query() query: DealTrackQueryDto) {
    const data = await this.deals.earnings(userId, query.track);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Earnings') };
  }

  @Get('work')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Threads waiting, open and done',
    description:
      'Counted over every thread on the track, not over a page: "2 waiting" to somebody with nine ' +
      'is worse than no number at all.\n\n' +
      'The same three numbers `GET /professionals/home` returns as `myWork`, off the same ' +
      'implementation, so the two can never drift apart.\n\n' +
      'Owner-only, and `404` for a member with no shop or listing on this track.',
  })
  @ApiNotFoundResponse({ description: 'No shop or listing on this track.' })
  async work(@CurrentUserId() userId: string, @Query() query: DealTrackQueryDto) {
    const data = await this.deals.work(userId, query.track);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Work') };
  }

  @Get('conversation/:conversationId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Every agreement in a conversation',
    description:
      '`{ "deals": [ … ] }`, **oldest first**, live and settled together. A thread with none ' +
      'answers an empty list rather than a `404`: nothing agreed yet is an ordinary thread, not a ' +
      'missing resource.\n\n' +
      'The order is the server\u2019s and there is no sequence number — what distinguishes two ' +
      'agreements to a member is the order they happened in and the `terms.summary` each ' +
      'carries.\n\n' +
      '`viewerRole` is per-caller and decides every button on screen. `proposedByRole` is fixed ' +
      'for the life of the deal and decides who may accept it. `steps` carries only what has ' +
      'happened — the full order is derived from `terms`, and the rules that derive it are in the ' +
      '`POST /steps` description.',
  })
  @ApiForbiddenResponse({ description: 'Not a participant.' })
  async forConversation(
    @CurrentUserId() userId: string,
    @Param('conversationId') conversationId: string,
  ) {
    const data = await this.deals.forConversation(userId, conversationId);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Deals') };
  }

  @Post('conversation/:conversationId')
  @Idempotent()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Open another agreement in this conversation',
    description:
      'Money is **pence on the way in and a `Money` object on the way back**, as everywhere else ' +
      'in this API.\n\n' +
      'Creating a deal **does not mark `AGREED`**. It records `proposedByRole` and leaves the ' +
      'step for the other party: if the proposal marked it, the acceptor would have nothing to ' +
      'tap and the deal would be stuck before it began.\n\n' +
      '**It never touches an agreement already in the thread**, whatever state that one is in: a ' +
      'thread runs as many as the two of them need, and this always creates. Changing the terms ' +
      'of one is `PUT /deals/{id}/terms`, which names the agreement it means.\n\n' +
      '**Send an `Idempotency-Key`.** While a thread held one agreement a proposal delivered ' +
      'twice was harmless; now it leaves two of the same thing running. A replay hands back the ' +
      'agreement the first attempt created.\n\n' +
      'No cap on how many can run at once.\n\n' +
      'Only a thread about something being sold or done can carry a deal: a favour and an ' +
      'introduction are not sales, and those contexts return `422`.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Not a deal context, or the deposit is not less than the total.',
  })
  async propose(
    @CurrentUserId() userId: string,
    @Param('conversationId') conversationId: string,
    @Body() dto: ProposeDealDto,
  ) {
    const data = await this.deals.propose(userId, conversationId, dto);

    return { data, message: SuccessMessage.RESOURCE_CREATED('Deal') };
  }

  @Put(':id/terms')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Replace the terms of a proposal',
    description:
      'The counter, and the proposer\u2019s own correction. It used to be the same call as ' +
      'proposing, which worked only while a thread held one agreement and the server could guess ' +
      'which was meant. It cannot guess any more, so the agreement is named in the path.\n\n' +
      '**Whoever sends it becomes `proposedByRole`**, so acceptance passes to the other side. That ' +
      'is what makes a counter a counter rather than an edit.\n\n' +
      'Allowed only while the proposal is unagreed and not withdrawn: once both have agreed, the ' +
      'terms are a shared record and the way out of them is `POST /deals/{id}/problem`.',
  })
  @ApiConflictResponse({ description: 'Already agreed by both sides.' })
  @ApiUnprocessableEntityResponse({
    description: 'Withdrawn, or the deposit is not less than the total.',
  })
  async replaceTerms(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: ProposeDealDto,
  ) {
    const data = await this.deals.replaceTerms(userId, id, dto);

    return { data, message: SuccessMessage.RESOURCE_UPDATED('Terms') };
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Withdraw a proposal',
    description:
      'For the side that proposed it, and only before anybody has agreed. Without it a proposal ' +
      'nobody takes sits in the thread for ever.\n\n' +
      '**The agreement stays in the list**, with `isCancelled: true`. It is not deleted: what the ' +
      'two of them discussed is part of the record, and the thread\u2019s own notes would ' +
      'otherwise describe an agreement with nothing behind it. A withdrawn one offers nothing ' +
      'afterwards — no steps, no counter, no problem report — and counts towards no total.\n\n' +
      'An agreed deal is never withdrawn; that is what `problem` is for. Sending this twice is the ' +
      'same state twice, so it needs no key.',
  })
  @ApiForbiddenResponse({ description: 'Only the side that proposed it may withdraw it.' })
  @ApiConflictResponse({ description: 'Already agreed by both sides.' })
  async cancel(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.deals.cancel(userId, id);

    return { data, message: SuccessMessage.ACTION_SUCCESSFUL('Proposal withdrawn') };
  }

  @Post(':id/steps')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark one or more stages',
    description:
      '**A list, deliberately.** A buyer collecting and paying at the counter should not tap ' +
      'three times while the seller waits. Applied in order and atomically: if any one stage is ' +
      'invalid, none is applied.\n\n' +
      'The order is computed from the terms rather than fixed. `UPFRONT` puts the payment pair ' +
      'before fulfilment and `ON_COMPLETION` after it; a deposit sits right after `AGREED` and ' +
      'forces the balance to the end, so "deposit first" and "all of it up front" can never ' +
      'contradict each other.\n\n' +
      'Refused with `INVALID_TRANSITION` when: the stage belongs to the other side (a payer ' +
      'cannot mark `DISPATCHED`, a provider cannot mark `PAID`), a predecessor is unmarked, the ' +
      'stage is already marked, the terms are not agreed yet, or the marker is the one who ' +
      'proposed and is trying to accept their own terms.\n\n' +
      '`amount` accompanies `PAID` or `DEPOSIT_PAID` and is in pence. Omit it and the figure the ' +
      'terms imply is recorded. One paying stage per call: a deposit and a balance are two ' +
      'figures and one call carries one.\n\n' +
      'Each step leaves a system note in the thread, and the call sends **one** notification to ' +
      'the other party — not one per stage.',
  })
  @ApiUnprocessableEntityResponse({ description: 'INVALID_TRANSITION.' })
  async markSteps(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: MarkStepsDto,
  ) {
    const data = await this.deals.markSteps(userId, id, dto);

    return { data, message: SuccessMessage.RESOURCE_UPDATED('Deal') };
  }

  @Patch(':id/amount')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Correct the payer's figure",
    description:
      'Only the `PAYER` may call this, ever, confirmed or not — it is their own claim they are ' +
      'correcting.\n\n' +
      'And it is refused once the other side has confirmed the figure: `DEPOSIT_PAID` is locked ' +
      'by `DEPOSIT_CONFIRMED`, `PAID` by `PAYMENT_CONFIRMED`. The point of a confirmation is that ' +
      'neither party can afterwards revise the shared record alone. The way out of a ' +
      'wrong-but-confirmed amount is `POST /deals/{id}/problem`, not a quiet edit.',
  })
  @ApiForbiddenResponse({ description: 'Not the paying side.' })
  @ApiUnprocessableEntityResponse({
    description: 'Already confirmed, or no such payment to correct.',
  })
  async correctAmount(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: CorrectAmountDto,
  ) {
    const data = await this.deals.correctAmount(userId, id, dto);

    return { data, message: SuccessMessage.RESOURCE_UPDATED('Deal') };
  }

  @Post(':id/problem')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Flag a disagreement',
    description:
      'Flags it, notifies the other party, leaves a note in the thread, and opens or reuses the ' +
      "caller's thread with Circl's team with both sides' record in it.\n\n" +
      'It reverses no step, holds nothing and decides nothing. Circl does not adjudicate.',
  })
  @ApiOkResponse({ description: 'The deal, now flagged.' })
  async flagProblem(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: FlagProblemDto,
  ) {
    const data = await this.deals.flagProblem(userId, id, dto);

    return { data, message: SuccessMessage.ACTION_SUCCESSFUL('Problem flagged') };
  }
}
