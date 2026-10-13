import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Idempotent, RateLimit, SuccessMessage } from '@/common';
import { AdminJwtGuard } from '@/common/guards/admin-jwt.guard';
import { AdminBffGuard } from '../common/admin-bff.guard';
import { AdminPermissionGuard } from '../common/admin-permission.guard';
import { AdminAuthenticated, AdminPermissions, AdminPrincipal } from '../common/admin-principal';
import {
  ListDealProblemsDto,
  ListDisputesDto,
  ResolveDealProblemDto,
  ResolveDisputeDto,
  UpdateDisputeDto,
} from '../dtos/admin-dispute.dto';
import { AdminDisputeService } from '../services/admin-dispute.service';

/**
 * §5.17: disputes, and the deals somebody flagged.
 *
 * All of it behind `disputes:manage`, reads included — unlike every other section here, where
 * reading is a smaller permission than acting. The reason is that there is nothing to read without
 * acting: a dispute is two members' evidence against each other, and somebody who may look at it
 * and not answer it is a reader with no reason to be there.
 *
 * **Circl never moves money.** A resolution is a finding, not a settlement, and nothing in here
 * reverses a transaction — the platform was never holding one.
 */
@ApiExcludeController()
@ApiTags('Admin · Disputes')
@AdminAuthenticated()
@Controller('admin')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminDisputeController {
  constructor(private readonly disputes: AdminDisputeService) {}

  // `deals/problems` is declared before `deals/:id`, which carries a `ParseUUIDPipe`: below it,
  // `GET deals/problems` would be a 400 complaining that "problems" is not a uuid.

  @Get('disputes')
  @AdminPermissions('disputes:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The disputes queue',
    description:
      'Newest first, defaulting to `OPEN,IN_REVIEW`. `overdue` is past `expectedResolutionAt` ' +
      'and narrows to the open states as well, because a decided dispute cannot be late any ' +
      'more.\n\n' +
      '`otherParty` is worked out from the booking or enquiry: the dispute row names only who ' +
      'raised it, and a screen about a disagreement that shows one side is a screen about a ' +
      'complaint.',
  })
  async list(@Query() query: ListDisputesDto) {
    const { data, meta } = await this.disputes.list(query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Disputes') };
  }

  @Get('disputes/:id')
  @AdminPermissions('disputes:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'One dispute, with the evidence and what led to it',
    description:
      'Both parties’ evidence with signed URLs (five minutes), the booking or enquiry with its ' +
      'timeline, the deal the two of them recorded if there is one, and the conversation id.\n\n' +
      'The conversation itself is **not** here: it is two members’ private thread, and reading it ' +
      'goes through §5.6 with `linkedType: DISPUTE`. A dispute is a reason to ask for that grant, ' +
      'not a reason to be given the thread.',
  })
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    return {
      data: await this.disputes.detail(id),
      message: SuccessMessage.RESOURCE_FETCHED('Dispute'),
    };
  }

  @Patch('disputes/:id')
  @AdminPermissions('disputes:manage')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @Idempotent()
  @ApiOperation({
    summary: 'Take it on, hand it over, or promise a date',
    description:
      'The only state this sets is `IN_REVIEW`. Ending a dispute goes through `resolve`, because ' +
      'an ending needs an outcome and a note both parties can read.\n\n' +
      '`expectedResolutionAt` is **shown to both of them**, so it is a commitment rather than an ' +
      'internal note — which is why it is set here rather than computed from an SLA.\n\n' +
      'Moving it to `IN_REVIEW` tells both parties that somebody is looking. A dispute where the ' +
      'platform has gone quiet is the complaint underneath most complaints about a dispute.',
  })
  async update(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDisputeDto,
  ) {
    return { data: await this.disputes.update(actor, id, dto), message: 'Dispute updated' };
  }

  @Post('disputes/:id/resolve')
  @AdminPermissions('disputes:manage')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @Idempotent()
  @ApiOperation({
    summary: 'The finding',
    description:
      '`resolutionNote` is shown to **both** parties: a finding told to one of them is half a ' +
      'resolution, and the missing half is the one who hears a second-hand version of it.\n\n' +
      '`WITHDRAWN` ends it as withdrawn rather than resolved; the other four outcomes resolve it. ' +
      'A dispute that is already settled is 409 `ALREADY_DECIDED`.\n\n' +
      'The `Reasoned` fields are separate from `resolutionNote` on purpose — the reason code is ' +
      'the internal record of why staff acted, and the note is prose written for two members. ' +
      'Circl moves no money either way.',
  })
  async resolve(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveDisputeDto,
  ) {
    return { data: await this.disputes.resolve(actor, id, dto), message: 'Dispute resolved' };
  }

  @Get('deals/problems')
  @AdminPermissions('disputes:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Deals somebody flagged',
    description:
      'Defaults to `problemState=OPEN` — the flags nobody has settled. A deal flagged before this ' +
      'field existed has a null state and counts as open, which is what it is.\n\n' +
      '`lastStage` is the furthest step reached, which says how much of the deal had happened ' +
      'when somebody raised their hand.',
  })
  async problems(@Query() query: ListDealProblemsDto) {
    const { data, meta } = await this.disputes.problems(query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Deal problems') };
  }

  @Get('deals/:id')
  @AdminPermissions('disputes:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'One deal, in pence',
    description:
      'Terms, both parties, every step either of them marked, and the problem if there is one. ' +
      'Reading the thread the two of them agreed it in goes through §5.6.',
  })
  async deal(@Param('id', ParseUUIDPipe) id: string) {
    return {
      data: await this.disputes.deal(id),
      message: SuccessMessage.RESOURCE_FETCHED('Deal'),
    };
  }

  @Post('deals/:id/problem/resolve')
  @AdminPermissions('disputes:manage')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @Idempotent()
  @ApiOperation({
    summary: 'Settle a flagged deal',
    description:
      '`hasProblem` is **not** cleared: a member raised their hand and that is part of the ' +
      'deal’s record whatever happened next. What changes is `problemState`, which is this ' +
      'queue’s own field.\n\n' +
      'The note is posted into the support thread of whoever flagged it — not the thread the two ' +
      'members share, because a staff note about their disagreement posted there is staff joining ' +
      'the argument. A deal flagged again after this is open work again.',
  })
  async resolveProblem(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveDealProblemDto,
  ) {
    return {
      data: await this.disputes.resolveProblem(actor, id, dto),
      message: 'Problem settled',
    };
  }
}
