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
  ListServiceRequestsDto,
  OfferRequestDto,
  SearchProfessionalsDto,
  SendOutcomeDto,
  SetRequestCategoryDto,
} from '../dtos/admin-service-request.dto';
import { AdminServiceRequestService } from '../services/admin-service-request.service';

/**
 * "Let Circl handle it" — the staff side.
 *
 * A member described a problem they could not name a professional for. Somebody here reads it,
 * decides what kind of help it is, searches the professionals who could take it on, offers it to
 * several of them, and tells the member how it went. Nothing in this controller assigns work or
 * ranks anybody: the offer is a question, and the professional answers it.
 *
 * Reads open on `support:read`, because an agent answering a member about their request needs to
 * see where it got to. Acting needs `managed:manage` — this is the surface that puts a member's
 * problem in front of professionals in Circl's name.
 */
@ApiExcludeController()
@ApiTags('Admin · Service requests')
@AdminAuthenticated()
@Controller('admin/service-requests')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminServiceRequestController {
  constructor(private readonly requests: AdminServiceRequestService) {}

  @Get()
  @AdminPermissions('support:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The queue',
    description:
      'Defaults to `SUBMITTED,MATCHING` — the work, not its history. `uncategorised=true` is the ' +
      'first pass: the requests nobody has decided a category for yet.\n\n' +
      'The member’s words come in full and are never truncated — they are the request. ' +
      '`meta.unread` counts everything still `SUBMITTED` whatever the filters, so the badge does ' +
      'not move as somebody switches tabs.',
  })
  async list(@Query() query: ListServiceRequestsDto) {
    const { data, meta } = await this.requests.list(query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Service requests') };
  }

  @Get(':id')
  @AdminPermissions('support:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'One request, with every offer on it',
    description:
      'Carries who was asked, what each of them said and when — the half the member never sees. ' +
      '`category` is Circl’s decision and `memberCategory` is the member’s own guess; they are ' +
      'separate fields so nobody later mistakes one for the other.',
  })
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    return {
      data: await this.requests.detail(id),
      message: SuccessMessage.RESOURCE_FETCHED('Service request'),
    };
  }

  @Patch(':id/category')
  @AdminPermissions('managed:manage')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @Idempotent()
  @ApiOperation({
    summary: 'Decide what kind of help this is',
    description:
      'Recorded beside the member’s guess rather than over it. They may have said nothing, which ' +
      'is allowed and is the reason this route exists, or said something wrong — both are worth ' +
      'keeping for whoever reads the row next.',
  })
  async setCategory(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetRequestCategoryDto,
  ) {
    return { data: await this.requests.setCategory(actor, id, dto), message: 'Category set' };
  }

  @Get(':id/professionals')
  @AdminPermissions('support:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Professionals who could take it on',
    description:
      'Scoped, not scored. Every row is somebody a member could have found by browsing: live ' +
      'listing, taking work, not suspended, and verified in the category where that category is ' +
      'gated. Defaults to the category staff decided on, falling back to the member’s guess.\n\n' +
      'Search `q` matches a name, a listing title or a service they offer. `offerStatus` says ' +
      'whether this person already has an offer on this request, so nobody is asked twice.\n\n' +
      'The order is "most recently active first" and means nothing else — there is deliberately ' +
      'no ranking here for a staff member to mistake for a recommendation.',
  })
  async professionals(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: SearchProfessionalsDto,
  ) {
    const { data, meta } = await this.requests.searchProfessionals(id, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Professionals') };
  }

  @Post(':id/offers')
  @AdminPermissions('managed:manage')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit('ADMIN_WRITE')
  @Idempotent()
  @ApiOperation({
    summary: 'Offer this request to professionals',
    description:
      'Up to ten at once. Nothing is assigned — each of them is asked, and each decides. They ' +
      'are notified; the member is not told who was asked, and never will be.\n\n' +
      'Somebody who already has an offer on this request is skipped rather than refused. An ' +
      'unanswered offer lapses after 72 hours.\n\n' +
      'The request moves to `MATCHING` on the first offer, which is what turns the member’s ' +
      'screen from "nobody has read this yet" into "Circl has asked people".',
  })
  async offer(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OfferRequestDto,
  ) {
    const data = await this.requests.offer(actor, id, dto);

    return {
      data,
      message:
        data.offered === 1 ? 'Offered to 1 professional' : `Offered to ${data.offered} professionals`,
    };
  }

  @Post(':id/offers/:offerId/withdraw')
  @AdminPermissions('managed:manage')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @Idempotent()
  @ApiOperation({
    summary: 'Take an offer back',
    description:
      'Only one still waiting for an answer — 409 `ALREADY_DECIDED` otherwise, because an answer ' +
      'is not undone. The professional is not told: nothing was asked of them that they failed.',
  })
  async withdraw(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('offerId', ParseUUIDPipe) offerId: string,
  ) {
    return {
      data: await this.requests.withdrawOffer(actor, id, offerId),
      message: 'Offer withdrawn',
    };
  }

  @Post(':id/outcome')
  @AdminPermissions('managed:manage')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @Idempotent()
  @ApiOperation({
    summary: 'Tell the member how it went',
    description:
      '`FOUND` needs at least one acceptance — 422 otherwise, since there would be nothing to ' +
      'tell them about. `NONE` closes the request as "nobody available" and revokes every offer ' +
      'still outstanding.\n\n' +
      'Send `NONE` rather than leaving it. A request that goes quiet is worse for a member than ' +
      'one that was refused: they are left wondering whether to go and find somebody themselves, ' +
      'and nothing on their screen answers that.\n\n' +
      '`note` is Circl’s own sentence to the member, shown under the status. It is never ' +
      'templated and it is the only place "we have asked two agencies" can go.',
  })
  async outcome(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendOutcomeDto,
  ) {
    return {
      data: await this.requests.sendOutcome(actor, id, dto),
      message: dto.outcome === 'FOUND' ? 'The member has been told' : 'Closed, and the member told',
    };
  }
}
