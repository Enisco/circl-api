import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
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
  ListWebsiteSubmissionsDto,
  PatchWebsiteSubmissionDto,
} from '../dtos/admin-website-submission.dto';
import { AdminWebsiteSubmissionService } from '../services/admin-website-submission.service';

/**
 * §5.27: what arrived from the public website, and who is dealing with it.
 *
 * Three forms land here — a message, a feature suggestion, and a request to have an account
 * deleted by somebody who cannot or would rather not do it in the app. Before this existed each
 * one reached a human as an email to the team inbox and nothing else, which is tolerable for a
 * suggestion and not for a deletion: work taken out of somebody's inbox has no state anybody else
 * can see and leaves no record of who decided what.
 *
 * Reads open on `support:read` and writes on `support:manage` — the support inbox's own pair,
 * because this is the same job through a different door.
 *
 * **Nothing in this controller deletes an account.** A deletion request is a request. The deletion
 * is `POST admin/members/:id/anonymise`, which needs `members:delete`, makes the staff member type
 * the username, and audits the decision before destroying anything — and is addressed by member
 * id, not by the address a stranger typed into a public form.
 */
@ApiExcludeController()
@ApiTags('Admin · Website')
@AdminAuthenticated()
@Controller('admin/website-submissions')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminWebsiteSubmissionController {
  constructor(private readonly submissions: AdminWebsiteSubmissionService) {}

  @Get()
  @AdminPermissions('support:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The queue',
    description:
      'Defaults to `NEW,IN_PROGRESS` — the work, not its history. `q` searches the name, the ' +
      'address, the title and the body.\n\n' +
      '`meta.counts` and `meta.byType` are counted **unfiltered**, so the tab badges do not move ' +
      'as somebody switches between them.\n\n' +
      '`code` and `codeLabel` carry whichever of topic, area or reason this type has, so one card ' +
      'renders all three forms.',
  })
  async list(@Query() query: ListWebsiteSubmissionsDto) {
    const { data, meta } = await this.submissions.list(query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Website submissions') };
  }

  @Get(':id')
  @AdminPermissions('support:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'One submission, with its notes and anything else that address has sent',
    description:
      'The whole `body` rather than an excerpt, the internal notes (§4.7), and `others` — every ' +
      'other submission from the same address, which is what makes "is this a duplicate?" ' +
      'answerable.\n\n' +
      '`matchedMember` is resolved **live** rather than read from the stored id, so a link is ' +
      'never offered to an account that has since been deleted. Read it together with ' +
      '`checkedAt`: null with no `checkedAt` means the lookup has not run yet, which is not the ' +
      'same as "no account uses this address".\n\n' +
      '`ipHashPrefix` is twelve characters of a salted hash — enough to see that three ' +
      'submissions came from one place, and no use for anything else.',
  })
  async findOne(@CurrentUser() actor: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return {
      data: await this.submissions.findOne(actor, id),
      message: SuccessMessage.RESOURCE_FETCHED('Website submission'),
    };
  }

  @Patch(':id')
  @AdminPermissions('support:manage')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @Idempotent()
  @ApiOperation({
    summary: 'Move it along, or write down what was done',
    description:
      '`state`, `note`, or both — an empty body is a 422, because a `PATCH` that changes nothing ' +
      'is read by a portal as "saved".\n\n' +
      '`DONE` and `SPAM` are final (409 `INVALID_TRANSITION`): a reopened request cannot be told ' +
      'apart from a new one nobody has read, and the person has already been told what to expect. ' +
      'Setting `DONE` stamps `completedAt`. A `PATCH` to the state it is already in is a 200 that ' +
      'does nothing, so a dropdown can be saved without being changed.\n\n' +
      '`note` is filed in §4.7’s table like every other staff note — it appears in `notes` here ' +
      'and under `admin/notes`, it is internal, and the person who filled the form in never sees ' +
      'it. Written **after** the state change, so a note sent alongside a refused transition is ' +
      'not filed about something that did not happen.',
  })
  async patch(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchWebsiteSubmissionDto,
  ) {
    return {
      data: await this.submissions.patch(actor, id, dto),
      message: 'Submission updated',
    };
  }
}
