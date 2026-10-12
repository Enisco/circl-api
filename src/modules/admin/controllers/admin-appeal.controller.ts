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
import { AdminAnyPermission, AdminPermissions, AdminPrincipal } from '../common/admin-principal';
import { CreateAppealDto, DecideAppealDto, ListAppealsDto } from '../dtos/admin-appeal.dto';
import { AdminAppealService } from '../services/admin-appeal.service';

@ApiExcludeController()
@ApiTags('Admin · Appeals')
@Controller('admin/appeals')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminAppealController {
  constructor(private readonly appeals: AdminAppealService) {}

  @Post()
  @AdminAnyPermission('reports:escalate', 'moderation:decide')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Log an appeal',
    description:
      'An appeal arrives through Support, in the member’s words, and somebody writes it down — so ' +
      'this is staff logging what a member said rather than the member filing anything. The row ' +
      'keeps both: their statement, and who took it.\n\n' +
      'What is being appealed has to exist, be about this member and still be a decision there is ' +
      'something to argue with (a case has to have been decided; a withdrawn strike has nothing ' +
      'left to undo) — otherwise 400. One open appeal per decision, so a second is a 409.\n\n' +
      'Whoever made the original decision is recorded now, not looked up later: by the time ' +
      'somebody claims the appeal the trail may be several rows away, and R6 depends on knowing.',
  })
  async log(@CurrentUser() actor: AdminPrincipal, @Body() dto: CreateAppealDto) {
    return { data: await this.appeals.log(actor, dto), message: 'Appeal logged' };
  }

  @Get()
  @AdminPermissions('reports:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The appeals queue',
    description:
      'Defaults to `OPEN,IN_REVIEW`, sorted by what is closest to its SLA — an appeal is a member ' +
      'waiting for an answer about something that has already happened to them.',
  })
  async list(@CurrentUser() actor: AdminPrincipal, @Query() query: ListAppealsDto) {
    query.assertDepth();

    const { data, meta } = await this.appeals.list(actor, query);

    return { data, meta, message: 'Appeals retrieved' };
  }

  @Get(':id')
  @AdminPermissions('reports:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'One appeal, with what it is about',
    description:
      'Carries a line describing the decision being appealed, so the review page does not have ' +
      'to fetch the case, the strike or the suspension separately to say what happened.',
  })
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.appeals.detail(id), message: 'Appeal retrieved' };
  }

  @Post(':id/claim')
  @AdminPermissions('moderation:decide')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Take the appeal',
    description:
      'R6 is checked here rather than only at decide: the person who made the original decision ' +
      'cannot review the appeal against it, and finding that out *after* reading the member’s ' +
      'statement is too late. 403 `APPEAL_REVIEWER_CONFLICT`.',
  })
  async claim(@CurrentUser() actor: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.appeals.claim(actor, id), message: 'Appeal claimed' };
  }

  @Post(':id/decide')
  @AdminPermissions('moderation:decide')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Uphold or overturn',
    description:
      '`UPHELD` leaves the decision standing and tells the member it was looked at again. ' +
      '`OVERTURNED` undoes it: the strike is withdrawn, removed content comes back, a suspension ' +
      'is lifted — each of those is a different kind of undo, so it is dispatched on what was ' +
      'appealed. The member is told either way, and the note is required both ways: "we looked ' +
      'again" is not a reason.',
  })
  async decide(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideAppealDto,
  ) {
    return { data: await this.appeals.decide(actor, id, dto), message: 'Appeal decided' };
  }
}
