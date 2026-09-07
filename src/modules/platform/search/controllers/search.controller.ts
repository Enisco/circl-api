import { Controller, Get, HttpCode, HttpStatus, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
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
      'One endpoint, parameterised by `types`, doing exactly one job: the **All** view. A mixed, ' +
      'grouped preview with a true count per type, in one round trip.\n\n' +
      '**It takes no filters.** The moment the member narrows to a single type, leave `/search` ' +
      "and call that type's own list endpoint, which already has `q`, its own categories, sort " +
      'and paging (`GET /community/requests?q=visa&categories=LEGAL&page=2`). A subcategory is ' +
      'not a shared vocabulary: "Legal" is a request category, a profession code and a store ' +
      'category at the same time.\n\n' +
      '`limit` is **per type**, not overall, because the response is grouped and one overall ' +
      'limit would let a popular type starve the rest. `cityId` **biases** the ranking and does ' +
      'not filter.\n\n' +
      'Groups come back for every requested type, including empty ones. Order is not ' +
      'load-bearing: render them in whatever order the chip row uses.',
  })
  @ApiOkResponse({ type: SearchResponseDto })
  async run(@CurrentUserId() userId: string, @Query() query: SearchDto) {
    const { data } = await this.search.search(userId, query);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Search results') };
  }
}
