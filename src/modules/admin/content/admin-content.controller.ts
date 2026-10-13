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
import { CurrentUser, Idempotent, RateLimit, ReasonedDto, SuccessMessage } from '@/common';
import { AdminJwtGuard } from '@/common/guards/admin-jwt.guard';
import { AdminBffGuard } from '../common/admin-bff.guard';
import { AdminPermissionGuard } from '../common/admin-permission.guard';
import { AdminAuthenticated, AdminPermissions, AdminPrincipal } from '../common/admin-principal';
import {
  HideContentDto,
  ListContentDto,
  ListGroupMembersDto,
  RemoveContentDto,
  StoreComplianceDto,
} from './admin-content.dto';
import { AdminContentService } from './admin-content.service';
import { CONTENT_SLUGS } from './content-registry';

/**
 * §5.7: every kind of content on the platform, one screen per kind.
 *
 * Seventeen types behind one route, mapped to a `ReportTargetType` server-side. The alternative was
 * seventeen controllers, and the filters, the paging, the risk join and the history are the same
 * for all of them — the differences are per-kind data, which is where they live
 * (`content-registry.ts`) rather than in seventeen copies of this file.
 *
 * `:id` is deliberately **not** `ParseUUIDPipe`d: these ids come from seventeen tables and the
 * service already answers 404 for an id that is not of the kind being asked about, which is the
 * same answer with a better message.
 */
@ApiExcludeController()
@ApiTags('Admin · Content')
@AdminAuthenticated()
@Controller('admin/content')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminContentController {
  constructor(private readonly content: AdminContentService) {}

  @Get(':type')
  @AdminPermissions('content:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Every item of one content type',
    description:
      `One of: ${CONTENT_SLUGS.join(', ')}. Unknown types answer 404 with the list.\n\n` +
      'Deleted content is excluded by default — the list is what is on the platform — and ' +
      '`deleted=include|only` widens it. Filtering by `tier=CLEAN` includes content with **no ' +
      'scan at all**, which is most of the platform: a post nobody has scanned is not a post with ' +
      'something known against it.\n\n' +
      'A filter belonging to another type is refused by name rather than ignored: `?ratings=5` on ' +
      'requests would otherwise return every request.\n\n' +
      'A row **is** a `ContentRef` (§5.0): the id is `targetId`, and `excerpt`, `visibility`, ' +
      '`adminUrl`, the city’s name and the category’s label come with it, so the one content card ' +
      'the queue and a report case draw renders these rows too. `openCaseId` names the open ' +
      'report case about the item where there is one.',
  })
  async list(@Param('type') type: string, @Query() query: ListContentDto) {
    const { data, meta } = await this.content.list(type, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Content') };
  }

  @Get(':type/:id')
  @AdminPermissions('content:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'One item, with its risk, media, author and history anchors',
    description:
      'The same shape the queue item detail and a report case’s live content use, so a reviewer ' +
      'arriving from any of the three reads one page. `body.text` is the scanned body the risk ' +
      'signals’ offsets refer to; `deletedBy` says whether staff or the author took it down, and ' +
      'an author’s own deletion cannot be restored.',
  })
  async detail(@Param('type') type: string, @Param('id') id: string) {
    const data = await this.content.detail(type, id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Content') };
  }

  // Declared **above** `:type/:id` and its actions, because `groups` and `stores` are also valid
  // `:type` values: below them, `/content/groups/<id>/members` would match `:type/:id/...` and be
  // answered by the wrong handler. Nest matches in declaration order.
  @Get('groups/:id/members')
  @AdminPermissions('content:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Who is in a group',
    description:
      'Admins first, then longest-standing: the list is read to find who is responsible for a ' +
      'group before it is read to find who is in it.',
  })
  async groupMembers(@Param('id', ParseUUIDPipe) id: string, @Query() query: ListGroupMembersDto) {
    const { data, meta } = await this.content.groupMembers(id, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Members') };
  }

  @Patch('stores/:id/compliance')
  @AdminPermissions('content:moderate')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'A shop’s compliance state',
    description:
      '`SUSPENDED` **gates publishing**: the shop and its items drop out of browse and search. ' +
      '`UNDER_REVIEW` deliberately does not — it means somebody is looking, and taking a shop ' +
      'offline while that happens would make "we are checking" indistinguishable from "we ' +
      'decided". A state that is already set is a 409.',
  })
  async compliance(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StoreComplianceDto,
  ) {
    const { data, auditId } = await this.content.setStoreCompliance(actor, id, dto);

    return { data, meta: { auditId }, message: SuccessMessage.RESOURCE_UPDATED('Shop') };
  }

  @Get(':type/:id/history')
  @AdminPermissions('content:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'What has happened to this item, oldest first',
    description: 'The scans, the reports and the decisions, in the order they happened.',
  })
  async history(@Param('type') type: string, @Param('id') id: string) {
    const data = await this.content.history(type, id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('History') };
  }

  @Post(':type/:id/hide')
  @AdminPermissions('content:moderate')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @Idempotent()
  @ApiOperation({
    summary: 'Hold content while a human looks',
    description:
      'A hide is **not** a decision: the content is held, the author is told it is under review, ' +
      'and a `FLAGGED_CONTENT` item (HIGH, four working hours) is opened so it always ends in a ' +
      'decision. Without that, a hide is a way to make something disappear with nobody obliged ' +
      'to finish the thought.\n\n' +
      'Content that is already hidden or removed is a 409 — hiding it again would stamp a second ' +
      'hold over somebody else’s.',
  })
  async hide(
    @CurrentUser() actor: AdminPrincipal,
    @Param('type') type: string,
    @Param('id') id: string,
    @Body() dto: HideContentDto,
  ) {
    const { data, auditId } = await this.content.hide(actor, type, id, dto);

    return { data, meta: { auditId }, message: SuccessMessage.RESOURCE_UPDATED('Content') };
  }

  @Post(':type/:id/remove')
  @AdminPermissions('content:moderate')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @Idempotent()
  @ApiOperation({
    summary: 'Take content down and close what was open about it',
    description:
      '`strike` defaults to **false** here, unlike a queue decision (§6.6), because this screen ' +
      'is also how staff tidy up: a duplicate post or somebody’s test listing is removed without ' +
      'anybody having broken a rule.\n\n' +
      'Open queue items and report cases on the target are resolved with `REMOVE_CONTENT` — work ' +
      'left open on content that no longer exists is work a reviewer picks up and finds nothing ' +
      'to do.',
  })
  async remove(
    @CurrentUser() actor: AdminPrincipal,
    @Param('type') type: string,
    @Param('id') id: string,
    @Body() dto: RemoveContentDto,
  ) {
    const { data, auditId } = await this.content.remove(actor, type, id, dto);

    return { data, meta: { auditId }, message: SuccessMessage.RESOURCE_UPDATED('Content') };
  }

  @Post(':type/:id/restore')
  @AdminPermissions('content:moderate')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @Idempotent()
  @ApiOperation({
    summary: 'Put staff-removed content back',
    description:
      'Only a **staff** removal. An author who deleted their own post did not ask for it back, ' +
      'and restoring it would publish something somebody chose to withdraw — so that is a 409 ' +
      '`RESTORE_NOT_ALLOWED`, and `deletedBy` on the detail is what tells the two apart.',
  })
  async restore(
    @CurrentUser() actor: AdminPrincipal,
    @Param('type') type: string,
    @Param('id') id: string,
    @Body() dto: ReasonedDto,
  ) {
    const { data, auditId } = await this.content.restore(actor, type, id, dto);

    return { data, meta: { auditId }, message: SuccessMessage.RESOURCE_UPDATED('Content') };
  }

  @Post(':type/:id/rescan')
  @AdminPermissions('content:moderate')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'Ask for a fresh opinion on content that has not changed',
    description:
      'Worth having because the lexicon changes: a phrase added this morning was not in it when ' +
      'this was posted, and `MANUAL` is one of the triggers that scans anyway rather than ' +
      'short-circuiting on an unchanged hash. Audited even though the content does not change — ' +
      '"who asked, and when" is what explains a verdict that moved without an edit.',
  })
  async rescan(
    @CurrentUser() actor: AdminPrincipal,
    @Param('type') type: string,
    @Param('id') id: string,
  ) {
    const { data, auditId } = await this.content.rescan(actor, type, id);

    return { data, meta: { auditId }, message: SuccessMessage.RESOURCE_UPDATED('Scan') };
  }
}
