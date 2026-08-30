import { Controller, Get, HttpCode, HttpStatus, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUserId, JwtAuthGuard, SuccessMessage } from '@/common';
import { SearchService } from '../services/search.service';
import { SearchDto } from '../dtos/search.dto';
import { SearchResponseDto } from '../dtos/search-response.dto';

@ApiBearerAuth()
@Controller('search')
@ApiTags('Search')
@UseGuards(JwtAuthGuard)
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Search across every section',
    description:
      'One call in place of four, with Connect and Commerce actually searched rather than always ' +
      'empty. Each group carries the object shape that type\'s own list endpoint returns, so the ' +
      'client reuses its existing cards. Group order is by relevance, not a fixed type order.',
  })
    @ApiOkResponse({ type: SearchResponseDto })
  async run(@CurrentUserId() userId: string, @Query() query: SearchDto) {
    const { data } = await this.search.search(userId, query);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Search results') };
  }
}
