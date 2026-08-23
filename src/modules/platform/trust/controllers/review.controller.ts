import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId, Idempotent, JwtAuthGuard, SuccessMessage } from '@/common';
import {
  CreateReviewDto,
  ListReviewsDto,
  ReviewReplyDto,
  UpdateReviewDto,
} from '../dtos/review.dto';
import { ReviewService } from '../services/review.service';

@Controller('reviews')
@ApiTags('Trust · Reviews')
@UseGuards(JwtAuthGuard)
export class ReviewController {
  constructor(private readonly reviews: ReviewService) {}

  @Post()
  @Idempotent()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Leave a review',
    description:
      'One endpoint for all four contexts, because a review is a review. Eligibility is enforced ' +
      'server-side: a review is a claim about a real interaction, and the client cannot be the ' +
      'thing that decides one happened.',
  })
  async create(@CurrentUserId() userId: string, @Body() dto: CreateReviewDto) {
    const data = await this.reviews.create(userId, dto);

    return { data, message: SuccessMessage.RESOURCE_CREATED('Review') };
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Edit a review', description: 'Within 48 hours, then frozen.' })
  async update(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateReviewDto,
  ) {
    const data = await this.reviews.update(userId, id, dto);

    return { data, message: SuccessMessage.RESOURCE_UPDATED('Review') };
  }

  @Post(':id/reply')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Reply to a review about you', description: 'Once, publicly.' })
  async reply(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: ReviewReplyDto,
  ) {
    const data = await this.reviews.reply(userId, id, dto);

    return { data, message: 'Reply posted' };
  }

  @Get(':userId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reviews about a member',
    description:
      'Keyed by the subject USER, not by a listing — this is the "reviews travel with the user" ' +
      'promise made literal. `summary` is over all reviews regardless of the context filter, so ' +
      'the chips can show counts while a filter is applied.',
  })
  async listForUser(
    @CurrentUserId() viewerId: string,
    @Param('userId') subjectUserId: string,
    @Query() query: ListReviewsDto,
  ) {
    const { data, meta } = await this.reviews.listForUser(viewerId, subjectUserId, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Reviews') };
  }
}
