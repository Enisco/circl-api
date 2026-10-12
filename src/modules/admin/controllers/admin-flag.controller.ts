import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SuccessMessage } from '@/common';
import { AdminJwtGuard } from '@/common/guards/admin-jwt.guard';
import { AdminBffGuard } from '../common/admin-bff.guard';
import { AdminPermissionGuard } from '../common/admin-permission.guard';
import { AdminAuthenticated, AdminPermissions } from '../common/admin-principal';
import { ListFlagsDto } from '../dtos/admin-flag.dto';
import { AdminFlagService } from '../services/admin-flag.service';

/**
 * §5.12's flags: every scanned item, not only the ones that reached a reviewer.
 *
 * Read-only on purpose. Decisions are taken on the queue item — `openQueueItemId` on the detail is
 * the link to it — because a second place to act on flagged content is a second place for the
 * claim rules, the allowed decisions and the appeal bookkeeping to be got wrong.
 */
// Excluded from the public document, like every other admin controller: the member-facing spec
// is what the apps are built against, and staff routes in it read as endpoints anybody may call.
@ApiExcludeController()
@ApiTags('Admin · Flags')
@AdminAuthenticated()
@Controller('admin/flags')
// `AdminAuthenticated` is metadata the audit middleware reads; it guards nothing on its own.
// These three are what actually refuse an unauthenticated request.
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminFlagController {
  constructor(private readonly flags: AdminFlagService) {}

  @Get()
  @AdminPermissions('moderation:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Every scanned item, by tier, state, category and status',
    description:
      'Includes the LOW signals that were never queued, which is the point: a lexicon judged only ' +
      'on the items that crossed a threshold is judged on a biased sample of itself.',
  })
  async list(@Query() query: ListFlagsDto) {
    const { data, meta } = await this.flags.list(query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Flags') };
  }

  @Get(':id')
  @AdminPermissions('moderation:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'One safety row and every scan of it',
    description:
      'The scans oldest first, so "it got worse" and "it got better" do not swap places, and the ' +
      'classifier error beside each one — a week of timeouts is a thing a safety dashboard has to ' +
      'be able to show.',
  })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.flags.findOne(id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Flag') };
  }
}
