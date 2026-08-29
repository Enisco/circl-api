import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId, JwtAuthGuard } from '@/common';
import { NotificationFeedService } from '../services';
import { ListNotificationsDto } from '../dtos';

@Controller('notifications')
@ApiTags('Notifications')
@UseGuards(JwtAuthGuard)
export class NotificationController {
  constructor(private readonly feed: NotificationFeedService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The in-app notification list',
    description:
      'A different list from push (5.6): it includes things that never produce a push, and it ' +
      'survives a push being dismissed. `bucket` is computed server-side in the member\'s ' +
      'timezone (D32), and `meta.unreadTotal` is account-wide and backs the header badge.',
  })
  async list(@CurrentUserId() userId: string, @Query() query: ListNotificationsDto) {
    return this.feed.list(userId, query);
  }

  @Get('unread-count')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The badge, on its own',
    description:
      'The badge sits in the header of all four home screens and the shipped client gets it ' +
      'from `GET /notifications?limit=1`, throwing the row away. 6.1.4 names this endpoint as ' +
      'the preferred fix and says it will be adopted, so it is here: it is a single covered ' +
      'count and never touches the member\'s history.',
  })
  async unreadCount(@CurrentUserId() userId: string) {
    return { data: { unreadTotal: await this.feed.unreadTotal(userId) } };
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark every notification read' })
  async readAll(@CurrentUserId() userId: string) {
    return this.feed.markAllRead(userId);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark one notification read',
    description:
      'Returns the new `unreadTotal` in `data`, which is what the badge is set from, so it ' +
      'updates without a second call. Reading a notification is not acting on it: this never ' +
      'resolves, accepts or dismisses whatever it points at (6.1.2).',
  })
  async read(@CurrentUserId() userId: string, @Param('id') id: string) {
    return this.feed.markRead(userId, id);
  }
}
