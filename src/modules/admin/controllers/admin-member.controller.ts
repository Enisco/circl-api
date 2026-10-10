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
import { NoteSubjectType } from '@prisma/client';
import { AdminPageOptionsDto, CurrentUser, RateLimit, SuccessMessage } from '@/common';
import { AdminJwtGuard } from '@/common/guards/admin-jwt.guard';
import { AdminBffGuard } from '../common/admin-bff.guard';
import { AdminPermissionGuard } from '../common/admin-permission.guard';
import { AdminAnyPermission, AdminPermissions, AdminPrincipal } from '../common/admin-principal';
import { RevealMemberDto } from '../dtos/admin-member.dto';
import {
  MemberActivityQueryDto,
  MemberContentQueryDto,
  MemberReportsQueryDto,
  MemberReviewsQueryDto,
} from '../dtos/admin-member-tabs.dto';
import { CreateMemberNoteDto } from '../dtos/admin-note.dto';
import { ListMembersDto } from '../dtos/analytics-filter.dto';
import { AdminMemberService } from '../services/admin-member.service';
import { AdminMemberTabsService } from '../services/admin-member-tabs.service';
import { AdminNoteService } from '../services/admin-note.service';

@ApiExcludeController()
@ApiTags('Admin · Members')
@Controller('admin/members')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminMemberController {
  constructor(
    private readonly members: AdminMemberService,
    private readonly tabs: AdminMemberTabsService,
    private readonly notes: AdminNoteService,
  ) {}

  @Get()
  @AdminPermissions('members:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The member list',
    description:
      "Takes the shared member filter (§2.5) plus the list's own: `q`, `hasStrikes`, " +
      '`lastActiveFrom`/`To` and `hasSection`. `from`/`to` mean the sign-up date here, and unlike ' +
      'the analytics endpoints there is no default range — "the members" must not quietly mean ' +
      '"the members who joined this month".\n\n' +
      'Contact details are masked for every role. Matching an exact email needs ' +
      '`members:pii_reveal`; without it an email query returns nothing, so the list cannot be used ' +
      'to confirm which address an account holds.',
  })
  async list(@CurrentUser() actor: AdminPrincipal, @Query() query: ListMembersDto) {
    const { data, meta } = await this.members.list(actor, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Members') };
  }

  @Post('search')
  @AdminPermissions('members:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The member list, with the filters in the body',
    description:
      'The same parameters and the same response as `GET admin/members`. The portal uses this ' +
      'whenever there is a `q`, so that a name or an email address never reaches a URL, a browser ' +
      'history, a referrer header or an access log — which are the four places a search term ' +
      'survives after the person who typed it has moved on.',
  })
  async search(@CurrentUser() actor: AdminPrincipal, @Body() body: ListMembersDto) {
    const { data, meta } = await this.members.list(actor, body);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Members') };
  }

  @Get(':id')
  @AdminPermissions('members:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'One member',
    description:
      'The header and the summary of the detail page: masked contact, what they have made, how ' +
      'many open cases involve them, their pinned notes, and whether their strike count has ' +
      'reached the threshold at which the portal suggests a suspension. Nothing suspends itself.',
  })
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.members.detail(id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Member') };
  }

  @Get(':id/sessions')
  @AdminPermissions('members:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "A member's sessions",
    description:
      'IP addresses are reduced to their /24 — enough to see that two sessions came from the same ' +
      'place, or that one came from somewhere the member has never been, without recording where ' +
      'a person was sitting. The full address is available one session at a time through `reveal`.',
  })
  async sessions(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.members.sessions(id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Sessions') };
  }

  @Post(':id/reveal')
  @AdminPermissions('members:pii_reveal')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: "Uncover a member's real contact details",
    description:
      'Returns the plaintext of the fields asked for and nothing else, and writes an audit entry ' +
      'naming the fields and the reason — never the values. Masking everywhere else and revealing ' +
      'here is the whole arrangement: a list of two hundred members carries two hundred email ' +
      'addresses past somebody who needed one, and an export of it carries them somewhere nobody ' +
      'is watching.',
  })
  async reveal(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RevealMemberDto) {
    const { data, auditId } = await this.members.reveal(id, dto);

    return { data, meta: { auditId }, message: 'Revealed' };
  }

  // ─── The detail page's tabs (§5.4) ─────────────────────────────────────────

  @Get(':id/profile')
  @AdminPermissions('members:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The editable profile',
    description:
      'Every field a staff member may correct, with the contact details masked and the date of ' +
      "birth reduced to its band. `editableFields` is the caller's own allowlist from the same map " +
      'the `PATCH` enforces, so the form the portal draws and the fields the API accepts cannot ' +
      'drift — a form offering a field the API refuses is a correction that silently never happens.',
  })
  async profile(@CurrentUser() actor: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    const data = await this.tabs.profile(actor, id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Profile') };
  }

  @Get(':id/sections')
  @AdminPermissions('members:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'What they have in each part of the platform',
    description:
      'Community counts always; the professional, Connect and shop blocks are null where the ' +
      'member is not in that section, rather than zeroed — "no listing" and "a listing with no ' +
      'jobs" are different facts.',
  })
  async sections(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.tabs.sections(id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Sections') };
  }

  @Get(':id/activity')
  @AdminPermissions('members:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'One timeline, from seven sources',
    description:
      'Sign-up, sign-ins, what they made, what they were reported for, what was done to them, and ' +
      'any profile edit staff made — unioned in date order. `types` filters by dropping whole ' +
      'sources, so a narrower question is a cheaper query.\n\n' +
      "A member's own profile saves are not in it: `updated_at` is one timestamp, not a history, " +
      'so `PROFILE_EDIT` honestly means "changed by us".',
  })
  async activity(@Param('id', ParseUUIDPipe) id: string, @Query() query: MemberActivityQueryDto) {
    const { data, meta } = await this.tabs.activity(id, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Activity') };
  }

  @Get(':id/content')
  @AdminPermissions('members:read', 'content:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Everything they have authored',
    description:
      'Eleven content tables paged together by date, each row carrying what Guard knows about it ' +
      'where anything has looked at it — `risk: null` means nothing has, which is not the same as ' +
      '"looked at and found clean".\n\n' +
      '`visibilityState` is derived from the moderation queue until the per-content safety table ' +
      'ships: `PENDING_APPROVAL` for a live anonymous-post item, `VISIBLE` otherwise. Filtering by ' +
      '`LIMITED`, `HELD` or `REJECTED` therefore matches nothing yet.',
  })
  async content(@Param('id', ParseUUIDPipe) id: string, @Query() query: MemberContentQueryDto) {
    const { data, meta } = await this.tabs.content(id, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Content') };
  }

  @Get(':id/threads')
  @AdminPermissions('messages:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Their conversations — metadata only',
    description:
      'Who, how many and when; never a message body. Reading what two members said needs an ' +
      'access grant tied to a case (§5.6), and this list is what a staff member uses to decide ' +
      'which thread that grant should be for.',
  })
  async threads(@Param('id', ParseUUIDPipe) id: string, @Query() query: AdminPageOptionsDto) {
    const { data, meta } = await this.tabs.threads(id, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Threads') };
  }

  @Get(':id/deals')
  @AdminPermissions('members:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Money they agreed, either side of it',
    description:
      '`stage` is the furthest step reached, or `CANCELLED` — which is a state rather than a ' +
      'stage and overrides whatever it had got to.',
  })
  async deals(@Param('id', ParseUUIDPipe) id: string, @Query() query: AdminPageOptionsDto) {
    const { data, meta } = await this.tabs.deals(id, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Deals') };
  }

  @Get(':id/reports')
  @AdminPermissions('reports:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reports they filed, or reports about them',
    description:
      'R9: a caller with `reports:read` but not `moderation:read` gets `counterpart: null` on a ' +
      'received report, and `meta.counterpartHidden` says so. That somebody has been reported five ' +
      "times is support's business; who reported them is not — that is the one fact that turns a " +
      'report into a reprisal.',
  })
  async reports(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: MemberReportsQueryDto,
  ) {
    const { data, meta } = await this.tabs.reports(actor, id, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Reports') };
  }

  @Get(':id/reviews')
  @AdminPermissions('members:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reviews they wrote, or reviews about them',
    description:
      '`countsToAverage` is on each row because the excluded ones are the interesting ones: that ' +
      'is how a reciprocal five-star pair reads on the page.',
  })
  async reviews(@Param('id', ParseUUIDPipe) id: string, @Query() query: MemberReviewsQueryDto) {
    const { data, meta } = await this.tabs.reviews(id, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Reviews') };
  }

  @Get(':id/groups')
  @AdminPermissions('members:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Their groups',
    description:
      '`joinedAt` is null while they are still waiting to be let in, which `requestedAt` answers ' +
      'instead.',
  })
  async groups(@Param('id', ParseUUIDPipe) id: string, @Query() query: AdminPageOptionsDto) {
    const { data, meta } = await this.tabs.groups(id, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Groups') };
  }

  @Get(':id/enforcement')
  @AdminPermissions('members:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Strikes, suspensions and warnings',
    description:
      '`warnings` is not a fourth table: it is the strikes the member was actually told about. A ' +
      'strike with no `notifiedAt` is a recorded breach nobody informed them of, and the ' +
      'difference matters when somebody appeals something they say they never heard about.\n\n' +
      'A suspension lifted with nobody named is the expiry job rather than a person ' +
      '(`liftedByJob`), which is how a sentence that ran out is told apart from one somebody chose ' +
      'to end.',
  })
  async enforcement(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.tabs.enforcement(id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Enforcement') };
  }

  @Get(':id/linkable-cases')
  @AdminPermissions('messages:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The records a thread-access grant may be tied to',
    description:
      'A grant must name a case that exists, is visible to the caller, and involves the member ' +
      '(S9.1) — free text is never accepted, because "investigating a complaint" is not a reason ' +
      "anybody can check afterwards. Filtered by the caller's own permissions here rather than in " +
      'the portal: an option somebody can see but not use is an invitation to ask a colleague to ' +
      'use it for them.\n\n' +
      'Report cases, support threads and escalations join this list with their own sections.',
  })
  async linkableCases(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const data = await this.tabs.linkableCases(actor, id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Cases') };
  }

  @Get(':id/blocks')
  @AdminPermissions('moderation:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Who has blocked them, and whom they have blocked',
    description:
      'Behind `moderation:read` rather than `members:read`, because the shape of this is ' +
      'diagnostic: one member blocked by fifteen people in a week is a pattern, and the fifteen ' +
      'names are the people who did not want to be found by them.',
  })
  async blocks(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.tabs.blocks(id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Blocks') };
  }

  @Get(':id/audit')
  @AdminAnyPermission('audit:read', 'audit:read_area', 'audit:read_self')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Everything staff have done to this member',
    description:
      'Scoped per R8, applied in the query rather than after it. A reader with `audit:read_self` ' +
      'sees their own actions on this member and nothing else — a short list, and an honest one. ' +
      'Returning the rows and hiding them in the portal would mean a safeguarding entry had ' +
      'already crossed the wire.',
  })
  async audit(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: AdminPageOptionsDto,
  ) {
    const { data, meta } = await this.tabs.audit(actor, id, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Audit') };
  }

  @Get(':id/notes')
  @AdminPermissions('members:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Staff notes about a member',
    description: 'Pinned first. The member never sees these, which is why they are audited.',
  })
  async notesFor(@CurrentUser() actor: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    const data = await this.notes.list(actor, NoteSubjectType.MEMBER, id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Notes') };
  }

  @Post(':id/notes')
  @AdminPermissions('members:read')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'Leave a note about a member',
    description: 'The shorthand for `POST admin/notes` with `subjectType: MEMBER`.',
  })
  async addNote(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateMemberNoteDto,
  ) {
    const data = await this.notes.create(actor, {
      subjectType: NoteSubjectType.MEMBER,
      subjectId: id,
      body: dto.body,
      isPinned: dto.isPinned,
    });

    return { data, message: SuccessMessage.RESOURCE_CREATED('Note') };
  }
}
