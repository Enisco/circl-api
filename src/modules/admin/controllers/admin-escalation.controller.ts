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
import { CurrentUser } from '@/common';
import { AdminJwtGuard } from '@/common/guards/admin-jwt.guard';
import { AdminBffGuard } from '../common/admin-bff.guard';
import { AdminPermissionGuard } from '../common/admin-permission.guard';
import { AdminPermissions, AdminPrincipal } from '../common/admin-principal';
import {
  CreateEscalationDto,
  ListEscalationsDto,
  UpdateEscalationDto,
} from '../dtos/admin-escalation.dto';
import { AdminEscalationService } from '../services/admin-escalation.service';

/**
 * §5.10's second half: Support → Trust & Safety.
 *
 * Its own controller rather than more routes on `admin/reports`, because `escalations` is its own
 * first path segment in the portal's BFF allowlist and the two things are not the same: a report
 * case is work about a piece of content, an escalation is one colleague asking another about a
 * member.
 */
@ApiExcludeController()
@ApiTags('Admin · Escalations')
@Controller('admin/escalations')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminEscalationController {
  constructor(private readonly escalations: AdminEscalationService) {}

  @Post()
  @AdminPermissions('reports:escalate')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Hand a member’s problem to Trust & Safety',
    description:
      'Raised by whoever is in front of the member — usually Support — and answered by Trust & ' +
      'Safety.\n\n' +
      'With `targetType` and `targetId`, a **staff report** is filed into that target’s case as ' +
      'well, through the same path a member’s report takes: grouped by §7.1, snapshotted, and ' +
      're-scanned. So the content becomes work in the report queue rather than a description of ' +
      'work in somebody’s note, and `SAFETY` or `SCAM` makes that case urgent. The id of the ' +
      'case comes back as `reportCaseId`.\n\n' +
      'Without a target it is an ask about the member alone, which is the right shape for ' +
      '`ENFORCEMENT_REQUEST` and for a pattern of behaviour that is not any one post.',
  })
  async create(@CurrentUser() actor: AdminPrincipal, @Body() dto: CreateEscalationDto) {
    return { data: await this.escalations.create(actor, dto), message: 'Escalation raised' };
  }

  @Get()
  @AdminPermissions('reports:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The escalation list',
    description:
      '`state` defaults to `OPEN,ACKNOWLEDGED` — what is still outstanding. Sorted **oldest ' +
      'first**, because this is a list of people waiting: newest-first would leave the longest ' +
      'unanswered ask at the bottom of the last page.\n\n' +
      '`mine` is the ones *I raised*, not the ones assigned to me — an escalation has no ' +
      'assignee, and the person who raised it is the one who needs to know what happened to it. ' +
      '`meta.openCount` is the dashboard’s `openEscalations`, unfiltered.',
  })
  async list(@CurrentUser() actor: AdminPrincipal, @Query() query: ListEscalationsDto) {
    query.assertDepth();

    const { data, meta } = await this.escalations.list(actor, query);

    return { data, meta, message: 'Escalations retrieved' };
  }

  @Get(':id')
  @AdminPermissions('reports:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'One escalation' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.escalations.findOne(id), message: 'Escalation retrieved' };
  }

  @Patch(':id')
  @AdminPermissions('moderation:decide')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Acknowledge or resolve an escalation',
    description:
      '`OPEN → ACKNOWLEDGED` says somebody has it, which is the difference between "nobody has ' +
      'looked at this" and "it is in hand" — the reading the raiser cannot make for themselves. ' +
      '`→ RESOLVED` closes it and is final: an escalation reopened is a new escalation, because ' +
      'by then the thing being escalated has moved on. Anything else is `409 ' +
      'INVALID_TRANSITION`, with the transitions that *are* allowed in `data.allowed`.\n\n' +
      '`resolutionNote` is stored only with `RESOLVED`.\n\n' +
      'Raised by `reports:escalate`, answered by `moderation:decide` — deliberately not the same ' +
      'permission, so the colleague who asked is not the one who closes it.',
  })
  async update(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEscalationDto,
  ) {
    return { data: await this.escalations.update(actor, id, dto), message: 'Escalation updated' };
  }
}
