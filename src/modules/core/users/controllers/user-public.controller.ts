import { Controller, Get, HttpCode, HttpStatus, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { User } from '@prisma/client';
import { JwtAuthGuard, Role, RoleGuard, USER_ROLE_CODE } from '@/common';
import { UserActivityService, UserPublicService } from '../services';
import { ListUserActivityDto } from '../dtos';

/** A member's public profile and history (0.16.3, 0.16.5). */
@ApiBearerAuth()
@Controller(':id')
@ApiTags('Users')
@UseGuards(JwtAuthGuard, RoleGuard)
@Role(USER_ROLE_CODE)
export class UserPublicController {
  constructor(
    private readonly users: UserPublicService,
    private readonly activity: UserActivityService,
  ) {}

  @Get('profile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Another member's public profile",
    description:
      'What anyone may see. Private fields and anything the member has hidden are omitted rather ' +
      'than returned as null. `id` also accepts `me`, which resolves to the caller.',
  })
  async profile(@Req() req: Request, @Param('id') id: string) {
    const viewer = req.user as User;

    return this.users.profile(id, viewer.id);
  }

  @Get('activity')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Another member's activity",
    description:
      'Their public contributions across every section, newest first, paged over all six sources ' +
      'at once. Anonymous posts are attributed to nobody, and `meta.byType` counts what the ' +
      'caller can actually see rather than what exists (0.16.5, D37).',
  })
  async activityList(
    @Req() req: Request,
    @Param('id') id: string,
    @Query() query: ListUserActivityDto,
  ) {
    const viewer = req.user as User;

    return this.activity.list(UserPublicService.subjectId(id, viewer.id), viewer.id, query);
  }
}
