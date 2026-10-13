import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TaxonomyKind } from '@prisma/client';
import { CurrentUser, CurrentUserId, RateLimit, SuccessMessage } from '@/common';
import { AdminJwtGuard } from '@/common/guards/admin-jwt.guard';
import { AdminBffGuard } from '../common/admin-bff.guard';
import { AdminPermissionGuard } from '../common/admin-permission.guard';
import { AdminAuthenticated, AdminPermissions, AdminPrincipal } from '../common/admin-principal';
import { AuditService } from '../audit/audit.service';
import {
  PatchRiskTermDto,
  ListRiskTermsDto,
  ReorderTaxonomyDto,
  SuspendUserDto,
  TaxonomyQueryDto,
  TestPhraseDto,
  UpsertRiskTermDto,
  UpsertTaxonomyTermDto,
} from '../dtos/admin.dto';
import { CreateGuardCaseDto, ListGuardCasesDto, UpdateGuardCaseDto } from '../dtos/admin-guard.dto';
import { AdminSearchDto } from '../dtos/admin-search.dto';
import { AdminJobRunnerService } from '../jobs/admin-job-runner.service';
import { AdminGuardService } from '../services/admin-guard.service';
import { AdminModerationService } from '../services/admin-moderation.service';
import { AdminSearchService } from '../services/admin-search.service';
import { AdminTaxonomyService } from '../services/admin-taxonomy.service';

/**
 * The staff endpoints that existed before the admin portal, moved onto the admin guard stack.
 *
 * They used to sit behind the **member** guard, so any member token belonging to a user with a
 * staff role worked here — and a staff row could obtain one through the member email-code flow,
 * which has no password and no second factor. A phished inbox was an administrator (B1).
 */
@ApiExcludeController()
@Controller('admin')
@ApiTags('Admin')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminController {
  constructor(
    private readonly moderation: AdminModerationService,
    private readonly guard: AdminGuardService,
    private readonly taxonomy: AdminTaxonomyService,
    private readonly jobs: AdminJobRunnerService,
    private readonly palette: AdminSearchService,
    private readonly audit: AuditService,
  ) {}

  // ─── Command palette (§5.27) ───────────────────────────────────────────────

  /**
   * One box that finds a member, a colleague or a piece of content.
   *
   * A `POST` carrying the query in the body, which is the whole reason the route exists in this
   * shape: the query is a name, an email address or a username, and a GET would write all three
   * into the access log, the browser history and the `Referer` of whatever the staff member clicks
   * next. §2.6 is explicit that member identifiers never reach a URL.
   *
   * Each section is gated on its own permission and **omitted** when the caller lacks it, which is
   * the convention §5.24 set for dashboard widgets: an empty list means "nothing matched", a
   * missing key means "not yours to search". A moderator shown an empty `staff` array would
   * reasonably conclude there is nobody here called Sarah.
   */
  @Post('search')
  @AdminAuthenticated()
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_SEARCH')
  @ApiOperation({
    summary: 'The command palette',
    description:
      'Exact matches first \u2014 an id or an email address pasted from a report is the keystroke ' +
      'this endpoint exists to save, and burying it under fuzzy name matches wastes it. Ordered ' +
      'in SQL rather than afterwards, so the ordering survives the limit of five.\n\n' +
      'An email query from a caller without `members:pii_reveal` matches nothing (\u00a75.4), or ' +
      'the palette becomes a way to confirm which address an account holds, one guess at a time.',
  })
  async palettes(@CurrentUser() actor: AdminPrincipal, @Body() body: AdminSearchDto) {
    const data = await this.palette.search(actor, body.q);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Search') };
  }

  // ─── Moderation queue ──────────────────────────────────────────────────────
  //
  // Moved to `AdminQueueController` (§5.9): the list gained CSV filters, a priority, a deadline,
  // `allowedDecisions` and a detail endpoint, and `claim` moved from `moderation:read` to
  // `moderation:decide` — reading a queue and taking an item out of it are not the same right.
  // Kept here as a note rather than deleted silently, because two controllers mounting
  // `admin/moderation/queue` is a duplicate route where the first one registered quietly wins.

  // ─── Circl Guard ───────────────────────────────────────────────────────────

  @Get('guard/cases')
  @AdminPermissions('guard:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The Guard case queue',
    description:
      'Private-to-Circl threads, ranked by urgency. Deliberately behind its own permission: reading ' +
      'these is a different job from triaging spam.',
  })
  async guardCases(@CurrentUser() actor: AdminPrincipal, @Query() query: ListGuardCasesDto) {
    const { data, meta } = await this.guard.list(actor, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Cases') };
  }

  @Post('guard/cases')
  @AdminPermissions('guard:manage')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'Escalate something to Guard',
    description:
      'Opens **the member’s existing** private thread rather than a second one beside it (D36): ' +
      'a safeguarding conversation split in half is two files that each read as the whole story. ' +
      'A staff-raised case never opens below MEDIUM — somebody looked at something and decided it ' +
      'needed safeguarding, so it does not sort below the spam.',
  })
  async createGuardCase(@CurrentUser() actor: AdminPrincipal, @Body() dto: CreateGuardCaseDto) {
    const { data, auditId } = await this.guard.create(actor, dto);

    return { data, meta: { auditId }, message: SuccessMessage.RESOURCE_CREATED('Case') };
  }

  @Get('guard/cases/:id')
  @AdminPermissions('guard:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'One Guard case',
    description:
      'One case for staff, with its risk signals and history. Requires the `guard:read` ' +
      'permission.',
  })
  async guardCase(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.guard.findOne(id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Case') };
  }

  @Patch('guard/cases/:id')
  @AdminPermissions('guard:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Assign or move a Guard case',
    description:
      'Assigning joins the staff member to the thread: a case you cannot read is one you cannot work.',
  })
  async updateGuardCase(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGuardCaseDto,
  ) {
    const { data, auditId } = await this.guard.update(actor, id, dto);

    return { data, meta: { auditId }, message: SuccessMessage.RESOURCE_UPDATED('Case') };
  }

  // ─── The Guard lexicon ───────────────────────────────────────────────────
  //
  // Served at `admin/risk-terms`, with the older `admin/guard/risk-terms` paths kept as
  // aliases until the portal has switched (§5.13). One handler per verb, two routes each: a
  // second copy of each handler would be a second place for the rules to drift.

  @Get(['risk-terms', 'guard/risk-terms'])
  @AdminPermissions('risk_terms:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Guard's risk lexicon",
    description:
      'The crisis vocabulary, for review. The app carries its own compiled copy too: detection ' +
      'has to work with no network, and must not tell the server what somebody typed before they ' +
      'choose to send it.',
  })
  async riskTerms(@Query() query: ListRiskTermsDto) {
    const { data, meta } = await this.taxonomy.listRiskTerms(query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Risk terms') };
  }

  @Post(['risk-terms', 'guard/risk-terms'])
  @AdminPermissions('risk_terms:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Add or retune a risk phrase',
    description:
      'The phrase is stored in the same normalised form the scanner applies to member text — ' +
      'NFKC, lowercased, invisible characters stripped, leetspeak folded, whitespace collapsed — ' +
      'and its length is checked after that. A pattern that was only lowercased could contain a ' +
      'zero-width character or a leetspeak digit and never match anything, and nothing said so: ' +
      'it sat in the list looking active with a hit count of zero.\n\n' +
      'Every instance is told its copy is stale, so a phrase added the moment staff see it used ' +
      'is matching within seconds rather than within two minutes.',
  })
  @RateLimit('ADMIN_WRITE')
  async upsertRiskTerm(@Body() dto: UpsertRiskTermDto) {
    const data = await this.taxonomy.upsertRiskTerm(dto);

    return { data, message: SuccessMessage.RESOURCE_UPDATED('Risk term') };
  }

  @Post(['risk-terms/test', 'guard/risk-terms/test'])
  @AdminPermissions('risk_terms:manage')
  @HttpCode(HttpStatus.OK)
  @RateLimit('PHRASE_TEST')
  @ApiOperation({
    summary: 'Try a phrase against some text before it goes live',
    description:
      'Returns every match with its offsets, the blended score, the tier and what the platform ' +
      'would actually do — `PUBLISH`, `LOG`, `LIMIT`, `HOLD` or `HOLD_AND_GUARD` — derived from ' +
      'the same function the scanner uses, so the answer cannot drift from the behaviour it ' +
      'describes.\n\n' +
      '**The offsets index `lexicon.normalisedText`, not the text you sent.** Matching happens on ' +
      'normalised text and every step of that can change the string’s length, so highlight ' +
      'against the normalised copy returned here. It also answers the question staff keep asking: ' +
      'what does the scanner actually see?\n\n' +
      'Nothing is written, so nothing is audited. The classifier is off unless asked for: it is a ' +
      'paid call per test.',
  })
  async testPhrase(@Body() dto: TestPhraseDto) {
    const data = await this.taxonomy.testPhrase(dto);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Result') };
  }

  @Patch(['risk-terms/:id', 'guard/risk-terms/:id'])
  @AdminPermissions('risk_terms:manage')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'Retune one phrase: weight, category, notes, on or off',
    description:
      "`pattern` is **not** accepted, and sending it is a 400 naming the field. A term's hit " +
      'count and false-positive rate are evidence about one exact phrase, and that evidence is ' +
      'what staff use to judge whether it is worth keeping — editing the words in place would ' +
      "quietly hand one phrase's record to another. To change a phrase, turn this one off and " +
      'add a new one.',
  })
  async patchRiskTerm(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PatchRiskTermDto) {
    const data = await this.taxonomy.patchRiskTerm(id, dto);

    return { data, message: SuccessMessage.RESOURCE_UPDATED('Risk term') };
  }

  @Delete(['risk-terms/:id', 'guard/risk-terms/:id'])
  @AdminPermissions('risk_terms:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Turn a risk phrase off',
    description: 'Deactivated rather than deleted, so it stays off through the next seed run.',
  })
  async removeRiskTerm(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.taxonomy.removeRiskTerm(id);

    return { data, message: 'Risk term deactivated' };
  }

  // ─── Taxonomy ──────────────────────────────────────────────────────────────
  //
  // `kinds` is declared **above** `:kind` because Nest matches in declaration order: with `:kind`
  // first, `GET admin/taxonomy/kinds` was read as a request for the kind "kinds", and the
  // parameter was unvalidated — so the portal's first call on the configuration screen reached the
  // database with a nonsense enum value. It is an enum pipe now, so a bad kind is a 400 naming
  // what was allowed.

  @Get('taxonomy/kinds')
  @AdminPermissions('config:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The vocabularies that can be edited',
    description:
      'With how many terms each holds and how many are active. Only the kinds §5.19 names: the ' +
      'enum carries vocabularies the client **matches on** — sort options, feed types, units — ' +
      'and rewording one of those from a screen would change behaviour rather than wording.',
  })
  async taxonomyKinds() {
    return {
      data: await this.taxonomy.kinds(),
      message: SuccessMessage.RESOURCE_FETCHED('Taxonomy kinds'),
    };
  }

  @Get('taxonomy/:kind')
  @AdminPermissions('config:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Every term of one kind, active or not',
    description:
      'Unlike the public endpoint, this shows the deactivated ones so they can be turned on. ' +
      '`includeUsage=true` adds `usageCount` — how many rows carry each code, which is the ' +
      'warning somebody needs before retiring a live category. Counted per kind from whatever ' +
      'actually uses it; kinds with no countable source report 0.',
  })
  async listTaxonomy(
    @Param('kind', new ParseEnumPipe(TaxonomyKind)) kind: TaxonomyKind,
    @Query() query: TaxonomyQueryDto,
  ) {
    const data = await this.taxonomy.list(kind, query.includeUsage === true);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Terms') };
  }

  @Post('taxonomy/:kind/reorder')
  @AdminPermissions('config:taxonomy')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'Put a vocabulary in order',
    description:
      'The whole list, once each. `sort` decides what a member sees first in a picker, so a ' +
      'partial list is refused rather than applied to the part it covers — the terms left out ' +
      'would all keep position zero and all come first. One version bump for the move.',
  })
  async reorderTaxonomy(
    @Param('kind', new ParseEnumPipe(TaxonomyKind)) kind: TaxonomyKind,
    @Body() dto: ReorderTaxonomyDto,
  ) {
    const data = await this.taxonomy.reorder(kind, dto.codes);

    return { data, message: 'Order saved.' };
  }

  @Post('taxonomy')
  @AdminPermissions('config:taxonomy')
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
  @AdminPermissions('config:taxonomy')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Deactivate a term',
    description:
      'Never deleted: content already carries this code, and removing the term would leave rows ' +
      'pointing at a label that no longer exists.',
  })
  async deactivateTaxonomy(
    @Param('kind', new ParseEnumPipe(TaxonomyKind)) kind: TaxonomyKind,
    @Param('code') code: string,
  ) {
    const data = await this.taxonomy.deactivate(kind, code);

    return { data, message: 'Term deactivated' };
  }

  // ─── Members ───────────────────────────────────────────────────────────────

  @Patch('users/:id/status')
  @AdminPermissions('members:suspend')
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
}
