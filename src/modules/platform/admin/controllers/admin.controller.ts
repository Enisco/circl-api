import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ReportTargetType, TaxonomyKind } from '@prisma/client';
import {
  CurrentUserId,
  JwtAuthGuard,
  PermissionGuard,
  Permissions,
  SuccessMessage,
} from '@/common';
import {
  DecideQueueItemDto,
  ListGuardCasesDto,
  ListQueueDto,
  ListRiskTermsDto,
  SuspendUserDto,
  UpdateGuardCaseDto,
  UpsertRiskTermDto,
  UpsertTaxonomyTermDto,
} from '../dtos/admin.dto';
import { PlatformJobsService } from '../../jobs/platform-jobs.service';
import { AdminGuardService } from '../services/admin-guard.service';
import { AdminModerationService } from '../services/admin-moderation.service';
import { AdminTaxonomyService } from '../services/admin-taxonomy.service';

/** Staff endpoints. */
@Controller('admin')
@ApiTags('Admin')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AdminController {
  constructor(
    private readonly moderation: AdminModerationService,
    private readonly guard: AdminGuardService,
    private readonly taxonomy: AdminTaxonomyService,
    private readonly jobs: PlatformJobsService,
  ) {}

  // ─── Moderation queue ──────────────────────────────────────────────────────

  @Get('moderation/queue')
  @Permissions('moderation:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The moderation queue',
    description:
      'One ordered list, ranked by urgency then report weight then age — which is what stops a ' +
      'member in danger sitting behind a backlog of spam. Every row carries the content itself and ' +
      'the matched risk phrases, so a decision does not need a second screen. `meta.urgentCount` ' +
      'is the number that should never sit.',
  })
  async listQueue(@CurrentUserId() adminId: string, @Query() query: ListQueueDto) {
    const { data, meta } = await this.moderation.listQueue(query, adminId);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Queue') };
  }

  @Post('moderation/queue/:id/claim')
  @Permissions('moderation:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Claim a queue item',
    description:
      'Conflicts if someone else already has it: two people working one disclosure is worse than one.',
  })
  async claim(@CurrentUserId() adminId: string, @Param('id') id: string) {
    const data = await this.moderation.claim(adminId, id);

    return { data, message: 'Claimed' };
  }

  @Post('moderation/queue/:id/decide')
  @Permissions('moderation:decide')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve, remove, or act on the author',
    description:
      'The anonymous-post queue and the reported-content queue share this, because the decision is ' +
      'the same shape. Every decision writes an append-only action record.',
  })
  async decide(
    @CurrentUserId() adminId: string,
    @Param('id') id: string,
    @Body() dto: DecideQueueItemDto,
  ) {
    const data = await this.moderation.decide(adminId, id, dto);

    return { data, message: 'Decision recorded' };
  }

  @Get('moderation/actions/:targetType/:targetId')
  @Permissions('moderation:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The audit trail for one piece of content or one member',
    description:
      'A safeguarding decision nobody can review afterwards is not one anyone should make.',
  })
  async actions(
    @Param('targetType') targetType: ReportTargetType,
    @Param('targetId') targetId: string,
  ) {
    const data = await this.moderation.actionsFor(targetType, targetId);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Actions') };
  }

  // ─── Circl Guard ───────────────────────────────────────────────────────────

  @Get('guard/cases')
  @Permissions('guard:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The Guard case queue',
    description:
      'Private-to-Circl threads, ranked by urgency. Deliberately behind its own permission: reading ' +
      'these is a different job from triaging spam.',
  })
  async guardCases(@Query() query: ListGuardCasesDto) {
    const { data, meta } = await this.guard.list(query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Cases') };
  }

  @Get('guard/cases/:id')
  @Permissions('guard:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'One Guard case' })
  async guardCase(@Param('id') id: string) {
    const data = await this.guard.findOne(id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Case') };
  }

  @Patch('guard/cases/:id')
  @Permissions('guard:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Assign or move a Guard case',
    description:
      'Assigning joins the staff member to the thread: a case you cannot read is one you cannot work.',
  })
  async updateGuardCase(
    @CurrentUserId() adminId: string,
    @Param('id') id: string,
    @Body() dto: UpdateGuardCaseDto,
  ) {
    const data = await this.guard.update(adminId, id, dto);

    return { data, message: SuccessMessage.RESOURCE_UPDATED('Case') };
  }

  @Get('guard/risk-terms')
  @Permissions('guard:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Guard's risk lexicon" })
  async riskTerms(@Query() query: ListRiskTermsDto) {
    const { data, meta } = await this.taxonomy.listRiskTerms(query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Risk terms') };
  }

  @Post('guard/risk-terms')
  @Permissions('guard:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Add or retune a risk phrase',
    description:
      'The scanner reloads within a couple of minutes, so a phrase added the moment staff see it ' +
      'used is matching this afternoon rather than at the next deploy.',
  })
  async upsertRiskTerm(@Body() dto: UpsertRiskTermDto) {
    const data = await this.taxonomy.upsertRiskTerm(dto);

    return { data, message: SuccessMessage.RESOURCE_UPDATED('Risk term') };
  }

  @Delete('guard/risk-terms/:id')
  @Permissions('guard:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Turn a risk phrase off',
    description: 'Deactivated rather than deleted, so it stays off through the next seed run.',
  })
  async removeRiskTerm(@Param('id') id: string) {
    const data = await this.taxonomy.removeRiskTerm(id);

    return { data, message: 'Risk term deactivated' };
  }

  // ─── Taxonomy ──────────────────────────────────────────────────────────────

  @Get('taxonomy/:kind')
  @Permissions('taxonomy:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Every term of one kind, active or not',
    description:
      'Unlike the public endpoint, this shows the deactivated ones so they can be turned on.',
  })
  async listTaxonomy(@Param('kind') kind: TaxonomyKind) {
    const data = await this.taxonomy.list(kind);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Terms') };
  }

  @Post('taxonomy')
  @Permissions('taxonomy:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Add a term, reword a label, or activate one',
    description:
      'This is what makes "reword without an app release" true. Bumps the taxonomy version, which ' +
      "invalidates every process's cache and the client's ETag in one write. Reword labels freely; " +
      'never rename a code that has shipped.',
  })
  async upsertTaxonomy(@Body() dto: UpsertTaxonomyTermDto) {
    const data = await this.taxonomy.upsert(dto);

    return { data, message: SuccessMessage.RESOURCE_UPDATED('Term') };
  }

  @Delete('taxonomy/:kind/:code')
  @Permissions('taxonomy:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Deactivate a term',
    description:
      'Never deleted: content already carries this code, and removing the term would leave rows ' +
      'pointing at a label that no longer exists.',
  })
  async deactivateTaxonomy(@Param('kind') kind: TaxonomyKind, @Param('code') code: string) {
    const data = await this.taxonomy.deactivate(kind, code);

    return { data, message: 'Term deactivated' };
  }

  // ─── Members ───────────────────────────────────────────────────────────────

  @Patch('users/:id/status')
  @Permissions('users:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Suspend or restore a member',
    description:
      'Suspension revokes every session immediately — one that leaves a live session running is not one.',
  })
  async setUserStatus(
    @CurrentUserId() adminId: string,
    @Param('id') id: string,
    @Body() dto: SuspendUserDto,
  ) {
    const data = await this.moderation.setUserStatus(adminId, id, dto);

    return { data, message: SuccessMessage.RESOURCE_UPDATED('Member') };
  }
  // ─── Scheduled jobs ────────────────────────────────────────────────────────

  @Post('jobs/:name/run')
  @HttpCode(HttpStatus.OK)
  @Permissions('jobs:run')
  @ApiOperation({
    summary: 'Run a scheduled job now',
    description:
      'The cron decorators are the schedule; this is the switch. Without it a stale dashboard ' +
      'cannot be fixed until the job\'s hour comes round, and the whole set is untestable end ' +
      'to end. Runs synchronously and returns when the job has finished.',
  })
  async runJob(@Param('name') name: string) {
    const ran = await this.jobs.runNow(name);

    return { data: { job: ran }, message: `Ran ${ran}` };
  }

}
