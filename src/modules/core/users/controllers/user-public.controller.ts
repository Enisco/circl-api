import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
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
      'than returned as null. `id` also accepts `me`, which resolves to the caller.\n\n' +
      '**`alsoOn`** names the member\u2019s other corners so a row of links opens theirs rather ' +
      'than the reader\u2019s: `professional { id, title }`, `store { id, name }`, ' +
      '`connect { id, type }`. Each key is **absent** when they are not in that section — an id, ' +
      'never a boolean, since a flag says there is something there and leaves the client unable to ' +
      'open it.\n\n' +
      '`connect` is also absent when the viewer would not see that profile in ' +
      '`GET /connect/profiles`: hidden, blocked either way, or a viewer who has not joined Connect ' +
      'themselves. It is the same rule, asked in the same place, so a community profile cannot ' +
      'become a way to find somebody who left discovery. A member always sees their own, which is ' +
      'ownership rather than visibility.',
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
