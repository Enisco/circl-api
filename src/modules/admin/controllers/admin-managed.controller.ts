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
  ListBriefsDto,
  ListManagedRequestsDto,
  PlaceBriefDto,
  UpdateBriefDto,
  UpdateManagedRequestDto,
} from '../dtos/admin-managed.dto';
import { AdminManagedService } from '../services/admin-managed.service';

/**
 * §5.16: the support pipeline — what Circl promised to do for somebody, and whether it got done.
 *
 * Reads open on `support:read`, because an agent answering a member about their shop needs to see
 * where that request got to. Acting on one needs `managed:manage`, which is a smaller group: this
 * is the pipeline that places members with professionals in Circl's name.
 */
@ApiExcludeController()
@ApiTags('Admin · Managed')
@AdminAuthenticated()
@Controller('admin/managed')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminManagedController {
  constructor(private readonly managed: AdminManagedService) {}

  // `requests` and `briefs` are literal segments, so nothing here collides with a `:id` route —
  // but the two detail routes are declared after their lists for the usual reason.

  @Get('requests')
  @AdminPermissions('support:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The pipeline',
    description:
      'Defaults to `OPEN,IN_PROGRESS` — the work, not its history. `cityIds` filters on the ' +
      '**member’s** city, because a managed request has none of its own.\n\n' +
      '`meta.unassigned` and `meta.mine` always count open work whatever the filters, so the tab ' +
      'badges do not move as somebody switches between them.',
  })
  async requests(@CurrentUser() actor: AdminPrincipal, @Query() query: ListManagedRequestsDto) {
    const { data, meta } = await this.managed.listRequests(actor, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Managed requests') };
  }

  @Get('requests/:id')
  @AdminPermissions('support:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'One request, with the shop or brief behind it',
    description:
      'Carries the internal notes as well: a pipeline row is read once, and the notes are the ' +
      'handover between two people working the same request on different days.',
  })
  async request(@Param('id', ParseUUIDPipe) id: string) {
    return {
      data: await this.managed.requestDetail(id),
      message: SuccessMessage.RESOURCE_FETCHED('Managed request'),
    };
  }

  @Patch('requests/:id')
  @AdminPermissions('managed:manage')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @Idempotent()
  @ApiOperation({
    summary: 'Move it along, hand it over, or close it',
    description:
      '`OPEN → IN_PROGRESS → CLOSED`, and closed is final (409 `INVALID_TRANSITION`). Closing ' +
      'without a `closedReason` is a 422: a closed request with no reason makes "we placed them" ' +
      'and "we could not help" the same row.\n\n' +
      '`note` is **appended** to the request’s running notes with the date and who wrote it, not ' +
      'substituted for them. It is internal; the member sees the system message instead.\n\n' +
      'An `assigneeId` has to hold `managed:manage` — handing work to somebody who cannot do it ' +
      'takes it out of the unassigned pool without taking it off anybody’s list.\n\n' +
      'Every state change posts a system message in the member’s Circl-team thread and notifies ' +
      'them. A managed request is a promise that somebody is dealing with it, and a pipeline that ' +
      'moves silently is one the member experiences as nothing happening.',
  })
  async updateRequest(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateManagedRequestDto,
  ) {
    return { data: await this.managed.updateRequest(actor, id, dto), message: 'Request updated' };
  }

  @Get('briefs')
  @AdminPermissions('support:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The briefs waiting for somebody',
    description:
      '`sort=urgency` is most urgent first, on the enum’s own order. `budgetPence` is pence, as ' +
      'every money field in the portal is.',
  })
  async briefs(@Query() query: ListBriefsDto) {
    const { data, meta } = await this.managed.listBriefs(query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Briefs') };
  }

  @Get('briefs/:id')
  @AdminPermissions('support:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'One brief, with the Smart Match shortlist behind it',
    description:
      'Each match carries the four scores it was ranked on and the sentence explaining it. The ' +
      'breakdown is the point: placing a member with somebody is a recommendation in Circl’s ' +
      'name, and "rank 1" with no reason is not something anybody can stand behind.\n\n' +
      '`acceptingWork` comes with each match because placing against a professional who has ' +
      'closed their books is a 422, and finding that out after choosing is a wasted decision.',
  })
  async brief(@Param('id', ParseUUIDPipe) id: string) {
    return {
      data: await this.managed.briefDetail(id),
      message: SuccessMessage.RESOURCE_FETCHED('Brief'),
    };
  }

  @Post('briefs/:id/place')
  @AdminPermissions('managed:manage')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @Idempotent()
  @ApiOperation({
    summary: 'Place the member with a professional',
    description:
      'Creates the booking **on the member’s behalf**, through the same service their own choice ' +
      'goes through: same `PENDING_ACCEPTANCE` state, same thread, same notification to the ' +
      'professional, same 422 `NOT_ACCEPTING_WORK` if they have closed their books. That is what ' +
      'keeps `PLACED` meaning "a booking exists".\n\n' +
      'What this adds is `placedBy` and `placedAt` — the record that **Circl** chose rather than ' +
      'the member, which is the first thing asked if the placement goes badly.\n\n' +
      'A brief that already has a booking is 409 `ALREADY_DECIDED`; a closed one is 409 ' +
      '`INVALID_TRANSITION`.',
  })
  async place(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PlaceBriefDto,
  ) {
    return { data: await this.managed.placeBrief(actor, id, dto), message: 'Placed' };
  }

  @Patch('briefs/:id')
  @AdminPermissions('managed:manage')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @Idempotent()
  @ApiOperation({
    summary: 'Match it, close it, or open it again',
    description:
      '`OPEN → MATCHED`, anything `→ CLOSED`, and `PLACED → OPEN` to place somebody else — that ' +
      'last one needs `moderation:assign` (§7.7), and clears the previous choice, because a brief ' +
      'that is open again with last time’s professional still named on it reads as placed to ' +
      'every screen that checks.\n\n' +
      'A `PATCH` to the state it is already in is a 200 and does nothing: the portal’s dropdown ' +
      'can be saved without being changed.',
  })
  async updateBrief(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBriefDto,
  ) {
    return { data: await this.managed.updateBrief(actor, id, dto), message: 'Brief updated' };
  }
}
