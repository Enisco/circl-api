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
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUserId, Idempotent, JwtAuthGuard, SuccessMessage } from '@/common';
import {
  AiDraftItemsDto,
  BrowseCommerceDto,
  CreateEnquiryDto,
  CreateStoreDto,
  ItemDto,
  ListEnquiriesDto,
  ListStoreItemsDto,
  StoreStatusDto,
  UpdateItemDto,
  UpdateStoreDto,
  ValidateCartDto,
} from '../dtos/store.dto';
import { CancelDto, TransitionReasonDto } from '../../professionals/dtos/booking.dto';
import { AiDraftService } from '../services/ai-draft.service';
import { CommerceBrowseService } from '../services/commerce-browse.service';
import { EnquiryService } from '../services/enquiry.service';
import { ItemService } from '../services/item.service';
import { StoreService } from '../services/store.service';

@ApiBearerAuth()
@Controller('commerce')
@ApiTags('Commerce')
@UseGuards(JwtAuthGuard)
export class CommerceController {
  constructor(
    private readonly stores: StoreService,
    private readonly items: ItemService,
    private readonly browse: CommerceBrowseService,
    private readonly enquiries: EnquiryService,
    private readonly ai: AiDraftService,
  ) {}

  // ─── 4.3 Home ──────────────────────────────────────────────────────────────

  @Get('home')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The Commerce home screen',
    description:
      'Works with no coordinates at all: location denied is not an error, and the "Near me" chip ' +
      'becomes a city picker.',
  })
  @ApiQuery({ name: 'cityId', required: false })
  @ApiQuery({ name: 'type', required: false })
  async home(
    @CurrentUserId() userId: string,
    @Query('cityId') cityId?: string,
    @Query('type') type?: string,
  ) {
    const data = await this.browse.home(userId, cityId, type);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Commerce home') };
  }

  // ─── 4.8.4 / 4.1.2 My store — before /stores/:id ───────────────────────────

  @Get('stores/setup/prefill')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Everything the store setup stepper already knows',
    description:
      'City, phone and a suggested logo come from the profile. If the seller edits the number, the ' +
      'store keeps its own and the profile is untouched — a shop line and a personal line are ' +
      'legitimately different.',
  })
  async setupPrefill(@CurrentUserId() userId: string) {
    const data = await this.stores.setupPrefill(userId);

    return { data, message: 'Prefill loaded' };
  }

  @Get('stores/me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'My store',
    description: '404 when they have none, for the empty state.',
  })
  async myStore(@CurrentUserId() userId: string) {
    const data = await this.stores.findMine(userId);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Store') };
  }

  @Get('stores/me/insights')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Store insights',
    description: 'Views, enquiries, conversion and top items. No earnings, payouts or balances.',
  })
  async insights(@CurrentUserId() userId: string) {
    const data = await this.stores.insights(userId);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Insights') };
  }

  // ─── 4.4 Browse ────────────────────────────────────────────────────────────

  @Get('stores')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Browse stores',
    description:
      'A store passes the price-band filter if ANYTHING it sells falls in the band. `isOpenNow` is ' +
      'computed server-side, so the badge and the filter always agree.',
  })
  async browseStores(@CurrentUserId() userId: string, @Query() query: BrowseCommerceDto) {
    const { data, meta } = await this.browse.browseStores(userId, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Stores') };
  }

  @Get('items')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Browse items',
    description:
      'The same filter vocabulary as stores; store-level filters read through to the store.',
  })
  async browseItems(@CurrentUserId() userId: string, @Query() query: BrowseCommerceDto) {
    const { data, meta } = await this.browse.browseItems(userId, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Items') };
  }

  // ─── 4.6 Cart ──────────────────────────────────────────────────────────────

  @Post('carts/validate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-price and check a cart',
    description:
      'The cart is client-side and in memory (D20), so a price change or a sell-out while it sat ' +
      'there is caught here — before the member sends anything.',
  })
  async validateCart(@Body() dto: ValidateCartDto) {
    const data = await this.enquiries.validateCart(dto);

    return { data, message: 'Cart checked' };
  }

  // ─── 4.7 Enquiries ─────────────────────────────────────────────────────────

  @Post('enquiries')
  @Idempotent()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Send an enquiry',
    description:
      'The server re-prices every line from the catalogue and never trusts a price sent by the ' +
      'client. `estimatedTotal` is an estimate, not a bill — Circl does not reconcile it against ' +
      'anything. Creates the conversation and returns its id.',
  })
  async createEnquiry(@CurrentUserId() userId: string, @Body() dto: CreateEnquiryDto) {
    const data = await this.enquiries.create(userId, dto);

    return { data, message: 'Enquiry sent' };
  }

  @Get('enquiries')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'My orders', description: '`role=SELLER` requires a store.' })
  async listEnquiries(@CurrentUserId() userId: string, @Query() query: ListEnquiriesDto) {
    const { data, meta } = await this.enquiries.list(userId, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Orders') };
  }

  @Get('enquiries/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Order detail',
    description: 'Same shape as a booking, with server-authorised actions.',
  })
  async findEnquiry(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.enquiries.findOne(userId, id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Order') };
  }

  @Post('enquiries/:id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Seller confirms they can fulfil it',
    description: 'Moves the enquiry to ACCEPTED and posts a system message into the thread.',
  })
  async acceptEnquiry(@CurrentUserId() userId: string, @Param('id') id: string) {
    return { data: await this.enquiries.accept(userId, id), message: 'Enquiry accepted' };
  }

  @Post('enquiries/:id/decline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Seller declines',
    description: 'Ends the enquiry. The reason is shown to the buyer.',
  })
  async declineEnquiry(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: TransitionReasonDto,
  ) {
    return {
      data: await this.enquiries.decline(userId, id, dto.reason),
      message: 'Enquiry declined',
    };
  }

  @Post('enquiries/:id/ready')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Out for delivery, or ready to collect',
    description: 'One state for both fulfilment modes, because the buyer\'s next action is the same either way.',
  })
  async readyEnquiry(@CurrentUserId() userId: string, @Param('id') id: string) {
    return { data: await this.enquiries.ready(userId, id), message: 'Marked as ready' };
  }

  @Post('enquiries/:id/received')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Buyer confirms receipt',
    description: 'Closes the enquiry and opens the review. There is no auto-complete here.',
  })
  async receivedEnquiry(@CurrentUserId() userId: string, @Param('id') id: string) {
    return { data: await this.enquiries.received(userId, id), message: 'Order closed' };
  }

  @Post('enquiries/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel', description: 'Either party, before it is ready.' })
  async cancelEnquiry(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: CancelDto,
  ) {
    return {
      data: await this.enquiries.cancel(userId, id, dto.reason),
      message: 'Order cancelled',
    };
  }

  // "Report a problem" on an order goes to POST /disputes with subjectType: ORDER (4.1.3).

  // ─── 4.8 Selling ───────────────────────────────────────────────────────────

  @Post('stores')
  @Idempotent()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Open a store', description: 'One store per user.' })
  async createStore(@CurrentUserId() userId: string, @Body() dto: CreateStoreDto) {
    const data = await this.stores.create(userId, dto);

    return { data, message: SuccessMessage.RESOURCE_CREATED('Store') };
  }

  @Patch('stores/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Edit a store',
    description:
      'Owner only. Sending `openingHours` or `heritageTags` replaces the whole set; omitting ' +
      'them leaves it alone.',
  })
  async updateStore(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateStoreDto,
  ) {
    const data = await this.stores.update(userId, id, dto);

    return { data, message: SuccessMessage.RESOURCE_UPDATED('Store') };
  }

  @Patch('stores/:id/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Open, close, or go on holiday',
    description: 'Overrides opening hours and excludes the store from openNow filters.',
  })
  async setStatus(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: StoreStatusDto,
  ) {
    const data = await this.stores.setStatus(userId, id, dto);

    return { data, message: SuccessMessage.RESOURCE_UPDATED('Store') };
  }

  @Get('stores/:id/demand-hints')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'What buyers near you are searching for',
    description:
      'Real searches only, and an empty array when the data does not support a claim. A fabricated ' +
      'demand signal that leads a seller to stock something nobody wants is worse than no card.',
  })
  async demandHints(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.browse.demandHints(userId, id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Demand hints') };
  }

  @Post('stores/:id/items')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Add an item',
    description:
      'Prices are always above zero (4.8.3). A free listing is a Community offer, not a Commerce '+
      'item.',
  })
  async addItem(@CurrentUserId() userId: string, @Param('id') id: string, @Body() dto: ItemDto) {
    const data = await this.items.create(userId, id, dto);

    return { data, message: SuccessMessage.RESOURCE_CREATED('Item') };
  }

  @Get('stores/:id/items')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'A store catalogue',
    description:
      'Out-of-stock items are included by default: they still tell a buyer what the shop sells.',
  })
  async listStoreItems(@Param('id') id: string, @Query() query: ListStoreItemsDto) {
    const { data, meta } = await this.items.listForStore(id, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Items') };
  }

  @Patch('items/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Edit an item, including the stock toggle',
    description:
      'Owner only. An item already in an enquiry is delisted rather than deleted, so the ' +
      'enquiry keeps its contents (4.8.3).',
  })
  async updateItem(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateItemDto,
  ) {
    const data = await this.items.update(userId, id, dto);

    return { data, message: SuccessMessage.RESOURCE_UPDATED('Item') };
  }

  @Delete('items/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove an item',
    description:
      'An item referenced by an open enquiry is delisted rather than deleted, or the enquiry loses ' +
      'its own contents.',
  })
  async removeItem(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.items.remove(userId, id);

    return { data, message: SuccessMessage.RESOURCE_DELETED('Item') };
  }

  @Get('items/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Item detail', description: 'With related items and a store strip.' })
  async findItem(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.items.findOne(userId, id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Item') };
  }

  // ─── 4.9 AI storefront builder ─────────────────────────────────────────────

  @Post('ai/draft-items')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Draft item listings from photos',
    description:
      'Drafts are NOT items — nothing appears in the catalogue until the seller accepts one. ' +
      'A price is only suggested when the model is confident AND the store has comparable prices ' +
      'to anchor against, and a low-confidence draft comes back with a name and no invented prose.',
  })
  async draftItems(@CurrentUserId() userId: string, @Body() dto: AiDraftItemsDto) {
    const data = await this.ai.draftItems(userId, dto);

    return { data, message: 'Drafts ready' };
  }

  @Get('ai/draft-items/:jobId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Poll a draft job',
    description:
      'The job holds its own result, so a client that drops the connection does not lose the ' +
      'work.',
  })
  async draftJob(@CurrentUserId() userId: string, @Param('jobId') jobId: string) {
    const data = await this.ai.jobStatus(userId, jobId);

    return { data, message: 'Job status' };
  }

  // ─── 4.5 Store profile — last, because :id is the catch-all ────────────────

  @Get('stores/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'A store profile',
    description:
      'When the seller hides their exact address, only the area and a coordinate rounded to roughly ' +
      'a kilometre are ever returned — line1, postcode and the precise point are never sent to ' +
      'anyone, including through the map.',
  })
  async findStore(@CurrentUserId() userId: string, @Param('id') id: string) {
    const store = await this.stores.storeOrThrow(id);
    const data = await this.stores.toDetail(store, userId, null);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Store') };
  }
}
