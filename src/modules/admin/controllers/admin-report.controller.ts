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
import { CurrentUser } from '@/common';
import { AdminJwtGuard } from '@/common/guards/admin-jwt.guard';
import { AdminBffGuard } from '../common/admin-bff.guard';
import { AdminPermissionGuard } from '../common/admin-permission.guard';
import { AdminPermissions, AdminPrincipal } from '../common/admin-principal';
import { ReasonOnlyDto } from '../dtos/admin-member-actions.dto';
import {
  AssignCaseDto,
  CaseDecisionDto,
  ListReportCasesDto,
  ListReportsDto,
} from '../dtos/admin-report-case.dto';
import { AdminReportCaseService } from '../services/admin-report-case.service';

@ApiExcludeController()
@ApiTags('Admin · Reports')
@Controller('admin/reports')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminReportController {
  constructor(private readonly cases: AdminReportCaseService) {}

  @Get('cases')
  @AdminPermissions('reports:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The report queue',
    description:
      'One row per case, which is one row per *target* — three people reporting one post is one ' +
      'piece of work (§7.1).\n\n' +
      '`state` defaults to `OPEN,IN_REVIEW`: the work still to do. The default sort follows from ' +
      'that — open work sorts urgent-first and then by whatever is closest to its SLA, while a ' +
      'list of decided states sorts by newest, because that is somebody looking something up ' +
      'rather than working a queue.\n\n' +
      '`memberId` is the **reported** member; `reporterId` finds cases somebody filed a report ' +
      'into. Reporters themselves are not in the row at all (R9) — only the detail carries them, ' +
      'and only for a caller with `reports:read`.',
  })
  async list(@CurrentUser() actor: AdminPrincipal, @Query() query: ListReportCasesDto) {
    query.assertDepth();

    const { data, meta } = await this.cases.list(actor, query);

    return { data, meta, message: 'Report cases retrieved' };
  }

  @Get('cases/:id')
  @AdminPermissions('reports:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'One case, with its evidence',
    description:
      'Every report grouped into it with its server-side snapshot, what else is known about the ' +
      'reported member, and the history of this target — the scans, the reports and the ' +
      'decisions.\n\n' +
      '`liveContent` and `appeals` are present and empty: the content page (§5.7) and appeals ' +
      '(§5.11) are not built yet, and an absent key would make the portal guess.',
  })
  async detail(@CurrentUser() actor: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.cases.detail(actor, id), message: 'Case retrieved' };
  }

  @Post('cases/:id/claim')
  @AdminPermissions('moderation:decide')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Take the case',
    description:
      'Moves it to `IN_REVIEW` and puts your name on it. A case somebody else is holding answers ' +
      '409 rather than changing hands quietly: two people working one disclosure is worse than ' +
      'one, and the second would not know.',
  })
  async claim(@CurrentUser() actor: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.cases.claim(actor, id), message: 'Case claimed' };
  }

  @Post('cases/:id/release')
  @AdminPermissions('moderation:decide')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Put it back',
    description:
      'Back to `OPEN` and unassigned. Releasing somebody else’s claim needs `moderation:assign` ' +
      '— a manager stepping in, which is the case §7.2 has in mind.',
  })
  async release(@CurrentUser() actor: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.cases.release(actor, id), message: 'Case released' };
  }

  @Post('cases/:id/assign')
  @AdminPermissions('moderation:decide')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Hand it to somebody',
    description:
      'Assigning to anybody but yourself needs `moderation:assign`. The assignee must hold ' +
      '`moderation:decide`: a case handed to somebody who cannot decide it stops looking ' +
      'unassigned and sits in a queue they are unable to clear.',
  })
  async assign(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignCaseDto,
  ) {
    return { data: await this.cases.assign(actor, id, dto), message: 'Case assigned' };
  }

  @Post('cases/:id/decide')
  @AdminPermissions('moderation:decide')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Decide it',
    description:
      'One decision answers every report in the case, which is what grouping them was for.\n\n' +
      'Claim it first — unless you hold `moderation:assign`, which is the manager stepping in. ' +
      '`NO_ACTION` publishes anything the scanner was holding (the reviewer has looked and it is ' +
      'fine); the `REMOVE*` decisions take the content down and mark the verdict rejected; ' +
      '`WARN_AUTHOR` and the `*_AND_*` pair go through the same enforcement the member screens ' +
      'use, so the strike and the suspension read as coming from this case rather than from ' +
      '"manual". Everyone who reported it is told the outcome unless you say otherwise, and they ' +
      'are told nothing about the other member.',
  })
  async decide(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CaseDecisionDto,
  ) {
    return { data: await this.cases.decide(actor, id, dto), message: 'Case decided' };
  }

  @Post('cases/:id/reopen')
  @AdminPermissions('moderation:decide')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reopen a decided case',
    description:
      'Thirty days after the decision, and not at all for an escalated one — Guard owns that now. ' +
      'It comes back as `IN_REVIEW` assigned to whoever reopened it, because somebody reopening a ' +
      'case has a reason to look at it.',
  })
  async reopen(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonOnlyDto,
  ) {
    return { data: await this.cases.reopen(actor, id, dto), message: 'Case reopened' };
  }

  @Get()
  @AdminPermissions('reports:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The raw report log',
    description:
      'Every report as filed, for the questions a case list cannot answer — what one member has ' +
      'been reporting, or what came in over an hour. Reporters are shown only to a caller with ' +
      '`reports:read` (R9).',
  })
  async reports(@CurrentUser() actor: AdminPrincipal, @Query() query: ListReportsDto) {
    query.assertDepth();

    const { data, meta } = await this.cases.listReports(actor, query);

    return { data, meta, message: 'Reports retrieved' };
  }
}
