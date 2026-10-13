import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ReportTargetType } from '@prisma/client';
import { CurrentUser, Idempotent } from '@/common';
import { AdminJwtGuard } from '@/common/guards/admin-jwt.guard';
import { AdminBffGuard } from '../common/admin-bff.guard';
import { AdminPermissionGuard } from '../common/admin-permission.guard';
import { AdminPermissions, AdminPrincipal } from '../common/admin-principal';
import { AssignQueueItemDto, DecideQueueDto, ListQueueItemsDto } from '../dtos/admin-queue.dto';
import { AdminQueueService } from '../services/admin-queue.service';
import { AdminModerationService } from '../services/admin-moderation.service';

@ApiExcludeController()
@ApiTags('Admin · Moderation queue')
@Controller('admin/moderation')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminQueueController {
  constructor(
    private readonly queue: AdminQueueService,
    private readonly moderation: AdminModerationService,
  ) {}

  // `summary` and `queue` are declared above `queue/:id`, which carries a `ParseUUIDPipe`: below
  // it, `GET …/moderation/summary` would be a 400 complaining that "summary" is not a uuid.

  @Get('summary')
  @AdminPermissions('moderation:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The tab headers',
    description:
      'Per type: how much is waiting, how much is being worked, how much is late, and when the ' +
      'oldest **open** item arrived. A resolved backlog does not make a tab look ancient.\n\n' +
      '`oldestAt` is a timestamp rather than an age, because an age computed here is already ' +
      'stale by the time it renders.',
  })
  async summary() {
    return { data: await this.queue.summary(), message: 'Summary retrieved' };
  }

  @Get('queue')
  @AdminPermissions('moderation:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The moderation queue',
    description:
      'One list, tabs are `type`. Defaults to the five types a reviewer works here — flagged ' +
      'content, anonymous posts, auto-guide drafts, Guard risk and appeals — and to the two open ' +
      'states.\n\n' +
      '`REPORTED_CONTENT` is deliberately **not** in the default set: those live at ' +
      '`admin/reports/cases`, which has its own decision shape. Showing them here would put the ' +
      'same work in two places and invite a decision in the one that cannot take it. The count ' +
      'is still in `meta.countsByType` so the portal can badge that tab.\n\n' +
      'Default order is band, then closest to breaching, then oldest — the order a reviewer ' +
      'should work in. `meta.countsByType` always counts **open** items whatever the filters, so ' +
      'the badges do not change as somebody moves between tabs.\n\n' +
      'Every row carries `allowedDecisions`: the buttons for that item, given its type, its ' +
      'target and the content’s current visibility. Render from it rather than inferring — a ' +
      'held item offers `APPROVE`, a limited one offers `RESTORE_REACH`, and the two are not ' +
      'synonyms.\n\n' +
      '`tier` is a filter like any other now: it was applied after paging, because the tier lives ' +
      'on the polymorphic safety table — which is joined on `(target_type, target_id)` instead, ' +
      'so the count, the rows and the paging describe one set. `meta.tierFilterIsPageLocal` is ' +
      'gone; nothing needs to read it.',
  })
  async list(@CurrentUser() actor: AdminPrincipal, @Query() query: ListQueueItemsDto) {
    query.assertDepth();

    const { data, meta } = await this.queue.list(actor, query);

    return { data, meta, message: 'Queue retrieved' };
  }

  @Get('queue/:id')
  @AdminPermissions('moderation:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'One item, with everything a decision needs',
    description:
      'The content as the scanner read it (`contentDetail.body`, field by field), what else is ' +
      'known about the author, the item’s payload, and every decision ever taken about this ' +
      'target.\n\n' +
      '`risk.signals[].start/end` are UTF-16 offsets into `contentDetail.body[field]` — the same ' +
      'strings returned here, which is why they are the scanned text rather than a rendered ' +
      'version of it. Highlight from them directly.',
  })
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.queue.detail(id), message: 'Item retrieved' };
  }

  @Post('queue/:id/claim')
  @AdminPermissions('moderation:decide')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOperation({
    summary: 'Take an item',
    description:
      'Two people working one disclosure is worse than one, so somebody else’s claim is a 409 ' +
      '`CLAIMED_BY_OTHER` with the holder in `data`.\n\n' +
      'Claiming an `APPEAL` item also moves its appeal to `IN_REVIEW` with the same reviewer — one ' +
      'claim, two rows, kept in sync. R6 is checked **here**: the person who took the original ' +
      'decision cannot review the appeal against it, and finding that out after reading the ' +
      'member’s statement is too late (403 `APPEAL_REVIEWER_CONFLICT`).',
  })
  async claim(@CurrentUser() actor: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.queue.claim(actor, id), message: 'Claimed' };
  }

  @Post('queue/:id/release')
  @AdminPermissions('moderation:decide')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOperation({
    summary: 'Put it back on the pile',
    description:
      'Your own claim, or anybody’s if you hold `moderation:assign` — 403 otherwise. A decided ' +
      'item is 409 `ALREADY_DECIDED`.\n\n' +
      'An `APPEAL` item’s appeal returns to `OPEN` with no reviewer: left naming somebody who has ' +
      'walked away, R6 would later refuse the only person able to pick it up.',
  })
  async release(@CurrentUser() actor: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.queue.release(actor, id), message: 'Released' };
  }

  @Post('queue/:id/assign')
  @AdminPermissions('moderation:decide')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Give it to somebody',
    description:
      'Leads only (`moderation:assign`, seeded to manager and super admin) — 403 otherwise, with ' +
      'the message pointing at `claim`, which is how reviewers take work.\n\n' +
      '`assigneeId: null` returns it to the unassigned pool. The assignee has to be an active ' +
      'staff account that can actually decide the item — `moderation:decide`, or `guard:manage` ' +
      'for a `GUARD_RISK` item, since safeguarding work belongs to the Guard team. Checked here ' +
      'rather than discovered at decide time by somebody who cannot press the button.',
  })
  async assign(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignQueueItemDto,
  ) {
    return {
      data: await this.queue.assign(actor, id, dto.assigneeId ?? null),
      message: dto.assigneeId ? 'Assigned' : 'Unassigned',
    };
  }
  @Post('queue/:id/decide')
  @AdminPermissions('moderation:decide')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve, remove, or act on the author',
    description:
      'The decision must be one of the item’s `allowedDecisions` (422 `INVALID_DECISION`). Every ' +
      'decision resolves the item and writes both an append-only `ModerationAction` and an audit ' +
      'entry — a safeguarding decision nobody can review afterwards is not one anybody should ' +
      'make.',
  })
  async decide(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideQueueDto,
  ) {
    const { data, meta } = await this.queue.decide(actor, id, dto);

    return { data, meta, message: 'Decision recorded' };
  }

  @Get('actions/:targetType/:targetId')
  @AdminPermissions('moderation:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The decision trail for one piece of content or one member',
    description:
      'Append-only, and resolved from the live staff row rather than joined: the table holds no ' +
      'foreign key to the user, so the record of a decision survives the deletion of the account ' +
      'that made it.',
  })
  async actions(
    @Param('targetType') targetType: ReportTargetType,
    @Param('targetId') targetId: string,
  ) {
    return {
      data: await this.moderation.actionsFor(targetType, targetId),
      message: 'Actions retrieved',
    };
  }
}
