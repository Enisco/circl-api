import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId, Idempotent, JwtAuthGuard, SuccessMessage, RateLimit } from '@/common';
import { CreateOfferDto, ListOffersDto, UpdateOfferDto } from '../dtos/offer.dto';
import { OfferService } from '../services/offer.service';

@ApiBearerAuth()
@Controller('community/offers')
@ApiTags('Community · Offers')
@UseGuards(JwtAuthGuard)
export class OfferController {
  constructor(private readonly offers: OfferService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List community offers',
    description:
      'Informal community services. An offer promoted into a verified professional listing drops ' +
      'out of this list, so the same person is not listed twice for the same thing.',
  })
  async list(@CurrentUserId() userId: string, @Query() query: ListOffersDto) {
    const { data, meta } = await this.offers.list(userId, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Offers') };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Offer detail',
    description:
      'One community offer with its author, city and price. A free offer carries no price basis '+
      '(1.4).',
  })
  async findOne(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.offers.findOne(userId, id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Offer') };
  }

  @Post()
  @Idempotent()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Post a community offer',
    description:
      'Both the "I can help" short form and the full Post a Service form land here. The Post a ' +
      'Service fork that continues to professional verification does NOT call this — it routes ' +
      'into Professionals and creates nothing here, or the member ends up listed twice.',
  })
  @RateLimit('CREATE')
  async create(@CurrentUserId() userId: string, @Body() dto: CreateOfferDto) {
    const data = await this.offers.create(userId, dto);

    return { data, message: SuccessMessage.RESOURCE_CREATED('Offer') };
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Edit an offer',
    description: 'Only the author, and only while it is live. Editing does not reset its position in the feed.',
  })
  async update(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateOfferDto,
  ) {
    const data = await this.offers.update(userId, id, dto);

    return { data, message: SuccessMessage.RESOURCE_UPDATED('Offer') };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete an offer',
    description:
      'Soft-deleted, so anyone already in a conversation about it keeps their record of what ' +
      'was offered.',
  })
  async remove(@CurrentUserId() userId: string, @Param('id') id: string) {
    await this.offers.remove(userId, id);
  }
}
