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
  AnnouncementInputDto,
  AudiencePreviewDto,
  ListAnnouncementsDto,
  ScheduleAnnouncementDto,
  SendAnnouncementDto,
  UpdateAnnouncementDto,
} from '../dtos/admin-announcement.dto';
import { AdminAnnouncementService } from '../comms/admin-announcement.service';
import { APP_ROUTES } from '../comms/app-routes';

/**
 * §5.18: one message from Circl to many members.
 *
 * All of it behind `communications:manage`, reads included, because there is nothing to read here
 * that is not a draft of something about to go out. The portal should put a confirmation in front
 * of `send`: it is the one write in the admin API with no undo.
 */
@ApiExcludeController()
@ApiTags('Admin · Announcements')
@AdminAuthenticated()
@Controller('admin')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminAnnouncementController {
  constructor(private readonly announcements: AdminAnnouncementService) {}

  // `announcements/audience-preview` is declared before `announcements/:id`, which carries a
  // `ParseUUIDPipe`: below it, the preview would be a 400 about "audience-preview" not being a uuid.

  @Get('meta/app-routes')
  @AdminPermissions('communications:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The screens an announcement may link to',
    description:
      'An allowlist of patterns, and a `route` that does not match one is refused. That is a ' +
      'security boundary rather than a convenience: an announcement reaches thousands of phones ' +
      'in Circl’s name, and a free-text link on it is the platform delivering whatever somebody ' +
      'typed.\n\n' +
      '`params` names the placeholders to ask for. A pattern with none is a tab.',
  })
  appRoutes() {
    return { data: APP_ROUTES, message: SuccessMessage.RESOURCE_FETCHED('App routes') };
  }

  @Get('announcements')
  @AdminPermissions('communications:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Everything sent, scheduled or still being written' })
  async list(@Query() query: ListAnnouncementsDto) {
    const { data, meta } = await this.announcements.list(query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Announcements') };
  }

  @Post('announcements/audience-preview')
  @AdminPermissions('communications:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'How many people this would reach, per channel',
    description:
      '`members` is the audience; `reachable` is how many of them each channel can actually land ' +
      'on. Push needs a handset **and** the member’s permission (on by default), and email is ' +
      '**opt-in** (off by default) — so a thousand-member audience may be a hundred emails, and ' +
      'showing one number for both is the misunderstanding this endpoint exists to prevent.\n\n' +
      'Counts under ten come back null with `suppressed: true`, as every other count does (§2.7).\n\n' +
      'Keep the `members` figure: `send` wants it back as `confirmAudienceCount`.',
  })
  async preview(@Body() dto: AudiencePreviewDto) {
    return {
      data: await this.announcements.preview(dto.audience, dto.channels),
      message: SuccessMessage.RESOURCE_FETCHED('Audience'),
    };
  }

  @Post('announcements')
  @AdminPermissions('communications:manage')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit('ADMIN_WRITE')
  @Idempotent()
  @ApiOperation({
    summary: 'Write one',
    description:
      'Arrives as a `DRAFT` and goes nowhere until `send` or `schedule`.\n\n' +
      '`audience.everyone` must be `true` to send with no filter: an empty filter does **not** ' +
      'mean the whole platform, because addressing everybody should be something somebody typed. ' +
      'With `PUSH` among the channels the body is capped at 500 characters — the OS cuts off the ' +
      'rest, and a message nobody can finish reading is not one.\n\n' +
      'Suspended members are never in an audience. The filter is resolved now as well as at send ' +
      'time, so one that cannot be resolved is a 400 on the draft rather than a failure nobody ' +
      'sees until the fan-out runs.',
  })
  async create(@CurrentUser() actor: AdminPrincipal, @Body() dto: AnnouncementInputDto) {
    return { data: await this.announcements.create(actor, dto), message: 'Draft saved' };
  }

  @Get('announcements/:id')
  @AdminPermissions('communications:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'One announcement, with its stats',
    description:
      '`stats` is null until it has been sent. `skippedPreference` is its own figure and never ' +
      'folded into `failed`: a member who turned announcements off was respected, not failed to. ' +
      '`opened` is null for `EMAIL` — tracking an email open needs a pixel, and one of those on a ' +
      'message to every member is surveillance this product does not do.',
  })
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    return {
      data: await this.announcements.detail(id),
      message: SuccessMessage.RESOURCE_FETCHED('Announcement'),
    };
  }

  @Patch('announcements/:id')
  @AdminPermissions('communications:manage')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @Idempotent()
  @ApiOperation({
    summary: 'Change a draft, or one that is scheduled',
    description:
      'Only `DRAFT` and `SCHEDULED` — 409 `INVALID_TRANSITION` otherwise, and one that has gone ' +
      'out says so: there is no unsend, so write a new one.',
  })
  async update(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAnnouncementDto,
  ) {
    return { data: await this.announcements.update(actor, id, dto), message: 'Saved' };
  }

  @Post('announcements/:id/send')
  @AdminPermissions('communications:manage')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @Idempotent({ required: true })
  @ApiOperation({
    summary: 'Send it now',
    description:
      '**There is no undo.** An `Idempotency-Key` is required, not optional, because a ' +
      'double-submitted send is the one mistake here that cannot be put right.\n\n' +
      '`confirmAudienceCount` is the figure you were shown. The audience is counted again and the ' +
      'send is refused with 409 `STALE_AUDIENCE` if it has moved by more than 5% — somebody who ' +
      'read "1,200 people" must not reach 12,000 because a filter changed meaning in between. ' +
      'Under ten recipients is 422 `AUDIENCE_TOO_SMALL`: an announcement to four people is a ' +
      'message, and should be sent as one.\n\n' +
      'Returns `SENDING`. The fan-out runs in batches of 500 and can be stopped with `cancel` ' +
      'between them; poll the detail for `stats`.',
  })
  async send(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendAnnouncementDto,
  ) {
    return { data: await this.announcements.send(actor, id, dto), message: 'Going out now' };
  }

  @Post('announcements/:id/schedule')
  @AdminPermissions('communications:manage')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @Idempotent()
  @ApiOperation({
    summary: 'Arm it for later',
    description:
      'At least five minutes out — so it can still be cancelled after it is set — and at most ' +
      'ninety days. The audience is counted now too, so a schedule over four people is refused ' +
      'when it is set rather than at 3am when it fires and nobody is watching.\n\n' +
      'Rescheduling replaces the earlier time rather than arming two.',
  })
  async schedule(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ScheduleAnnouncementDto,
  ) {
    return { data: await this.announcements.schedule(actor, id, dto), message: 'Scheduled' };
  }

  @Post('announcements/:id/cancel')
  @AdminPermissions('communications:manage')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @Idempotent()
  @ApiOperation({
    summary: 'Stop a schedule, or a send in progress',
    description:
      'A `SCHEDULED` one simply does not go. A `SENDING` one stops **between batches**: whoever ' +
      'already has it still has it, and the delivery rows say how many that was — the audit entry ' +
      'records it too, because it is the first thing anybody asks.\n\n' +
      'A `SENT` announcement is a 409. There is no unsend.',
  })
  async cancel(@CurrentUser() actor: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.announcements.cancel(actor, id), message: 'Cancelled' };
  }
}
