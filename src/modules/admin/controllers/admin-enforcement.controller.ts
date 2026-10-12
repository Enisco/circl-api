import { Controller, Get, HttpCode, HttpStatus, Query, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SuccessMessage } from '@/common';
import { AdminJwtGuard } from '@/common/guards/admin-jwt.guard';
import { AdminBffGuard } from '../common/admin-bff.guard';
import { AdminPermissionGuard } from '../common/admin-permission.guard';
import { AdminAuthenticated, AdminPermissions } from '../common/admin-principal';
import {
  ListActiveSuspensionsDto,
  ListBlocksDto,
  ListEnforcementDto,
} from '../dtos/admin-enforcement.dto';
import { AdminEnforcementLogService } from '../services/admin-enforcement-log.service';

/**
 * §5.14: what has been done to members, as a record.
 *
 * Read-only. Every row here is written by a decision somewhere else, with its own audit entry —
 * a way to create one from this screen would be a way to strike somebody with no decision
 * attached to it.
 */
@ApiExcludeController()
@ApiTags('Admin · Enforcement')
@AdminAuthenticated()
@Controller('admin')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminEnforcementController {
  constructor(private readonly log: AdminEnforcementLogService) {}

  @Get('enforcement')
  @AdminPermissions('moderation:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Every strike and suspension, newest first',
    description:
      'One list over both tables, paged and sorted together. A **warning is a strike** (§4.4) and ' +
      'not a third kind — `source` says where it came from. `endedAt` is a strike being revoked ' +
      'or a suspension being lifted: the same fact under one name, so nothing has to switch on ' +
      '`kind` to read it.',
  })
  async enforcement(@Query() query: ListEnforcementDto) {
    const { data, meta } = await this.log.list(query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Enforcement') };
  }

  // Declared above nothing in particular, but kept before `blocks` for readability: these two
  // share a controller only because they share a permission and a screen.
  @Get('enforcement/suspensions/active')
  @AdminPermissions('moderation:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Who cannot use the platform today',
    description:
      'Soonest-ending first with the permanent ones last — they have no end date, which is not ' +
      'the same as one infinitely far away. `meta.permanentCount` is the number staff actually ' +
      'want and the one a paged list of rows cannot be asked for.',
  })
  async activeSuspensions(@Query() query: ListActiveSuspensionsDto) {
    const { data, meta } = await this.log.activeSuspensions(query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Suspensions') };
  }

  @Get('blocks')
  @AdminPermissions('moderation:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Members a lot of people have blocked',
    description:
      'Aggregated, and **individual pairs are deliberately absent**: who blocked whom is private ' +
      'between those two members (§3.1.5 keeps a block invisible to the person blocked), and a ' +
      'list of pairs would be a list of exactly that. The count carries the signal without the ' +
      'names. Pairs stay reachable on one member’s own tab, where a reviewer is already on a case.',
  })
  async blocks(@Query() query: ListBlocksDto) {
    const { data, meta } = await this.log.blocks(query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Blocks') };
  }
}
