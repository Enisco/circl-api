import { Controller, Get, HttpCode, HttpStatus, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { User } from '@prisma/client';
import { JwtAuthGuard, Role, RoleGuard, USER_ROLE_CODE } from '@/common';
import { UserActivityService, UserPublicService } from '../services';
import { ListUserActivityDto } from '../dtos';

/** A member's public profile and history (0.16.3, 0.16.5). */
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
  async profile(@Req() req: Request, @Param('id') id: string) {
    const viewer = req.user as User;

    return this.users.profile(id, viewer.id);
  }

  @Get('activity')
  @HttpCode(HttpStatus.OK)
  async activityList(
    @Req() req: Request,
    @Param('id') id: string,
    @Query() query: ListUserActivityDto,
  ) {
    const viewer = req.user as User;

    return this.activity.list(UserPublicService.subjectId(id, viewer.id), viewer.id, query);
  }
}
