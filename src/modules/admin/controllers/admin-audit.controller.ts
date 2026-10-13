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
import { AdminJwtGuard } from '@/common/guards/admin-jwt.guard';
import { CurrentUser, RateLimit, SuccessMessage } from '@/common';
import { AdminBffGuard } from '../common/admin-bff.guard';
import { AdminPermissionGuard } from '../common/admin-permission.guard';
import { AdminAnyPermission, AdminAuthenticated, AdminPrincipal } from '../common/admin-principal';
import { ClientEventDto, ListAuditDto, SearchAuditDto } from '../dtos/admin-audit.dto';
import { AdminAuditService } from '../services/admin-audit.service';

/** The three permissions, in order of reach (R8). Any one of them opens every read here. */
const READERS = ['audit:read', 'audit:read_area', 'audit:read_self'] as const;

/**
 * §5.23: reading the audit trail.
 *
 * The writing has been in place since M0 and nothing in the portal could read it. Every milestone
 * since has been recording entries so that somebody could be asked about an action, with no
 * endpoint that would let anybody ask — so this is the half that makes the other half mean
 * something.
 *
 * **Nothing here deletes or edits an entry**, and there is deliberately no route that could: the
 * trail is append-only, and the only write on this controller appends.
 *
 * All three permissions open all five reads, and `AdminAuditService` narrows what comes back —
 * because R8 is a rule about *rows*, not about routes. A `audit:read_self` holder may read the
 * trail; what they may read of it is their own actions.
 */
@ApiExcludeController()
@ApiTags('Admin · Audit')
@Controller('admin/audit')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminAuditController {
  constructor(private readonly audit: AdminAuditService) {}

  // ─── The literal routes come first ─────────────────────────────────────────
  //
  // `actions`, `actors`, `search` and `client-event` are declared **above** `:id` on purpose.
  // Nest matches in declaration order, so with `:id` first, `GET admin/audit/actions` would be
  // read as an entry whose id is "actions" — which the UUID pipe would turn into a 400 about a
  // malformed id rather than serving the list. That is a confusing failure to debug from the
  // portal, and the fix is an ordering nobody can see.

  @Get('actions')
  @AdminAnyPermission(...READERS)
  @ApiOperation({
    summary: 'Every action the trail can record',
    description:
      'From the registry the audit writer itself uses, so the filter can only offer actions that ' +
      'exist. The same list is on `GET admin/meta/audit-actions`, for the screens that load ' +
      'their filter vocabulary in one call.',
  })
  actions() {
    return {
      data: this.audit.actions(),
      message: SuccessMessage.RESOURCE_FETCHED('Audit actions'),
    };
  }

  @Get('actors')
  @AdminAnyPermission(...READERS)
  @ApiOperation({
    summary: 'The staff who appear in entries you can read',
    description:
      'Scoped like the entries themselves (R8), which is why it is not the team list: a reader ' +
      'who may only see their own actions gets one name, rather than a dropdown of colleagues ' +
      'that returns nothing for each.',
  })
  async actors(@CurrentUser() actor: AdminPrincipal) {
    return {
      data: await this.audit.actors(actor),
      message: SuccessMessage.RESOURCE_FETCHED('Audit actors'),
    };
  }

  @Post('search')
  @AdminAnyPermission(...READERS)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The same list, with the filters in the body',
    description:
      'For the filters that carry member identifiers: `targetId` is a member’s id and `q` is ' +
      'their name, and §2.6 is explicit that neither reaches a URL — a GET writes both into the ' +
      'access log, the browser history and the `Referer` of whatever the reader clicks next. ' +
      'Reads nothing but the trail and writes nothing, so it takes no `Idempotency-Key`.',
  })
  async search(@CurrentUser() actor: AdminPrincipal, @Body() dto: SearchAuditDto) {
    const result = await this.audit.list(actor, dto);

    return { ...result, message: SuccessMessage.RESOURCE_FETCHED('Audit entries') };
  }

  @Post('client-event')
  // Any signed-in staff member, because the three actions are things the **portal** does and
  // everybody's portal does them. The allowlist is what makes this safe, not the permission.
  @AdminAuthenticated()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit('ADMIN_CLIENT_EVENT')
  @ApiOperation({
    summary: 'Record a CSV the portal built itself',
    description:
      'A CSV assembled in the browser from data it already had leaves no request for the server ' +
      'to audit — so without this, the one act that takes member data off the platform is the ' +
      'one act with no trail. Three actions only; anything else is a 400. The area is taken from ' +
      'the registry rather than the caller.',
  })
  async clientEvent(@CurrentUser() actor: AdminPrincipal, @Body() dto: ClientEventDto) {
    return {
      data: await this.audit.clientEvent(actor, dto),
      message: 'Recorded.',
    };
  }

  // ─── Then the list and the parameterised read ──────────────────────────────

  @Get()
  @AdminAnyPermission(...READERS)
  @ApiOperation({
    summary: 'The trail',
    description:
      'Newest first. Filters narrow **within** what you may see rather than widening it: asking ' +
      'for an area your scope excludes returns your own entries in that area, not everybody’s. ' +
      'Where a filter would carry a member’s name or id, use `POST admin/audit/search`.',
  })
  async list(@CurrentUser() actor: AdminPrincipal, @Query() query: ListAuditDto) {
    const result = await this.audit.list(actor, query);

    return { ...result, message: SuccessMessage.RESOURCE_FETCHED('Audit entries') };
  }

  @Get(':id')
  @AdminAnyPermission(...READERS)
  @ApiOperation({
    summary: 'One entry',
    description:
      '`404` where it is outside your scope, not `403`: a 403 on an id confirms that an entry ' +
      'with that id exists, which for a safeguarding action is most of what the reader was not ' +
      'allowed to know.',
  })
  async findOne(@CurrentUser() actor: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return {
      data: await this.audit.findOne(actor, id),
      message: SuccessMessage.RESOURCE_FETCHED('Audit entry'),
    };
  }
}
