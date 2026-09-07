import { Controller, Get, HttpCode, HttpStatus, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId, JwtAuthGuard, Role, RoleGuard, USER_ROLE_CODE } from '@/common';
import { UserDirectoryService } from '../services';
import { SearchUsersDto } from '../dtos';
import { PersonHitDto } from '../swagger/person-hit.dto';

/** Member search (0.16.6). The `PERSON` half of search, paginated. */
@ApiBearerAuth()
@Controller()
@ApiTags('Users')
@UseGuards(JwtAuthGuard, RoleGuard)
@Role(USER_ROLE_CODE)
export class UserDirectoryController {
  constructor(private readonly directory: UserDirectoryService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Search members by name',
    description:
      'The paginated People view. `GET /search` returns the first few of these under the `PERSON` ' +
      'group; this is where "See all" goes.\n\n' +
      'Matches display name and username, never bio, city or interests. Never returns anyone ' +
      'blocked in either direction, anyone suspended or deleted, or the caller. A member who posts ' +
      'anonymously is still findable by name: anonymity attaches to a post, not to a person.\n\n' +
      'When an exact match finds nothing, a trigram pass runs so a misspelt name still lands.',
  })
  @ApiOkResponse({ type: [PersonHitDto] })
  async list(@CurrentUserId() userId: string, @Query() query: SearchUsersDto) {
    return this.directory.list(userId, query);
  }
}
