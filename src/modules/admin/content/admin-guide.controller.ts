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
import { CurrentUser, Idempotent, RateLimit, ReasonedDto, SuccessMessage } from '@/common';
import { AdminJwtGuard } from '@/common/guards/admin-jwt.guard';
import { AdminBffGuard } from '../common/admin-bff.guard';
import { AdminPermissionGuard } from '../common/admin-permission.guard';
import { AdminAuthenticated, AdminPermissions, AdminPrincipal } from '../common/admin-principal';
import { GuideInputDto, GuidePerformanceDto, PatchGuideDto } from './admin-guide.dto';
import { AdminGuideService } from './admin-guide.service';

/**
 * §5.8: the guides Circl writes.
 *
 * Separate from §5.7's content screens, which list guides among sixteen other kinds and can hide or
 * remove one. This is the editor — authoring, publishing, and the numbers that say whether a guide
 * was worth writing.
 *
 * Reading is `content:read` so anybody who can see content can open the editor; every write is
 * `guides:publish`, which only manager, super admin and trust & safety hold. Publishing a guide is
 * publishing in Circl's own name.
 */
@ApiExcludeController()
@ApiTags('Admin · Guides')
@AdminAuthenticated()
@Controller('admin/guides')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminGuideController {
  constructor(private readonly guides: AdminGuideService) {}

  @Post()
  @AdminPermissions('guides:publish')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit('ADMIN_WRITE')
  @Idempotent()
  @ApiOperation({
    summary: 'Write a guide',
    description:
      'Authored by Circl — `authorId` is null, which the member-facing read path renders as "by ' +
      'Circl". It is scanned like any other content, because a guide is published copy and the one ' +
      'written by staff is the one nobody else will check.\\n\\n' +
      'A **draft** until somebody publishes it: writing `publishedAt` on create would put an ' +
      'unreviewed guide straight into the feed.',
  })
  async create(@CurrentUser() actor: AdminPrincipal, @Body() dto: GuideInputDto) {
    const { data, auditId } = await this.guides.create(actor, dto);

    return { data, meta: { auditId }, message: SuccessMessage.RESOURCE_CREATED('Guide') };
  }

  @Get(':id')
  @AdminPermissions('content:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'One guide, for the editor',
    description:
      'Whatever state it is in — a draft, an unpublished one, one a scan is holding. Those are ' +
      'the things this screen exists to show.',
  })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const { data } = await this.guides.findOne(id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Guide') };
  }

  @Patch(':id')
  @AdminPermissions('guides:publish')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'Edit a guide',
    description:
      'Every field optional; `blocks` replaces the whole list when sent. Re-scanned on every ' +
      'edit, even one that only moved a comma — the scan is of the words as they are now, and an ' +
      'edit is exactly when they changed.',
  })
  async update(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchGuideDto,
  ) {
    const { data, auditId } = await this.guides.update(actor, id, dto);

    return { data, meta: { auditId }, message: SuccessMessage.RESOURCE_UPDATED('Guide') };
  }

  @Post(':id/publish')
  @AdminPermissions('guides:publish')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @Idempotent()
  @ApiOperation({
    summary: 'Publish it',
    description:
      'Stamps `publishedAt`, `reviewedAt` and `reviewedById` — a review nobody is answerable for ' +
      'is the state §1.6.2 exists to prevent.\\n\\n' +
      'An **auto-generated** guide goes through `AutoGuideService.publish`, where the provenance ' +
      'rules live: a machine-drafted guide with no sources is refused rather than published bare. ' +
      'That also resolves its `AUTO_GUIDE` queue item.',
  })
  async publish(@CurrentUser() actor: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    const { data, auditId } = await this.guides.publish(actor, id);

    return { data, meta: { auditId }, message: SuccessMessage.RESOURCE_UPDATED('Guide') };
  }

  @Post(':id/unpublish')
  @AdminPermissions('guides:publish')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @Idempotent()
  @ApiOperation({
    summary: 'Take it out of the feed',
    description:
      'Clears `publishedAt` only. The review stays recorded: somebody did read it, and clearing ' +
      'that would make the next publish look like the first.',
  })
  async unpublish(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonedDto,
  ) {
    const { data, auditId } = await this.guides.unpublish(actor, id, dto);

    return { data, meta: { auditId }, message: SuccessMessage.RESOURCE_UPDATED('Guide') };
  }

  @Get(':id/performance')
  @AdminPermissions('content:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Whether it was worth writing',
    description:
      'Reads and the daily series come from the activity events rather than `viewCount`, which ' +
      'has no dates on it. The series carries every day in the window including the zeroes — a ' +
      'sparse one draws a line between two points a fortnight apart and calls it a trend.\\n\\n' +
      '`deflections` is the number that matters most: how often somebody about to post a question ' +
      'read this instead, and how often they posted anyway. A guide with a high read count and no ' +
      'deflections is being read by the wrong people. `rate` is null when the interstitial has ' +
      'never been shown — 0% reads as "it never helps", which is a different claim.',
  })
  async performance(@Param('id', ParseUUIDPipe) id: string, @Query() query: GuidePerformanceDto) {
    const { data } = await this.guides.performance(id, query);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Performance') };
  }
}
