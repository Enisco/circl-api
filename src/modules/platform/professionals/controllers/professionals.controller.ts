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
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUserId, Idempotent, JwtAuthGuard, SuccessMessage } from '@/common';
import { BrowseProfessionalsDto, ListSlotsDto } from '../dtos/browse.dto';
import {
  AvailabilityDto,
  CreateListingDto,
  PromoteOfferDto,
  ReplaceServicesDto,
  ServiceDto,
  UpdateListingDto,
  UpdateServiceDto,
} from '../dtos/listing.dto';
import { BrowseService } from '../services/browse.service';
import { ListingService } from '../services/listing.service';
import { ProfessionalsHomeService } from '../services/professionals-home.service';
import { AvailabilityService } from '../services/availability.service';

@Controller('professionals')
@ApiTags('Professionals')
@UseGuards(JwtAuthGuard)
export class ProfessionalsController {
  constructor(
    private readonly listings: ListingService,
    private readonly browse: BrowseService,
    private readonly home: ProfessionalsHomeService,
    private readonly availability: AvailabilityService,
  ) {}

  // ─── Fixed paths first, so they are never captured as an :id ───────────────

  @Get('home')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The Professionals home screen',
    description: 'One call for six strips, because six round trips would show six spinners.',
  })
  @ApiQuery({ name: 'cityId', required: false })
  async getHome(@CurrentUserId() userId: string, @Query('cityId') cityId?: string) {
    const data = await this.home.home(userId, cityId);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Professionals home') };
  }

  @Get('registration/prefill')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Everything the registration form already knows',
    description:
      'Call this BEFORE rendering "Become a Professional" and do not ask for anything it returns. ' +
      'The stepper renders from `steps`, not from a hardcoded count, so verification appearing ' +
      'later is a server change rather than an app release.',
  })
  @ApiQuery({ name: 'categoryCode', required: false })
  async prefill(@CurrentUserId() userId: string, @Query('categoryCode') categoryCode?: string) {
    const data = await this.listings.registrationPrefill(userId, categoryCode);

    return { data, message: 'Prefill loaded' };
  }

  @Get('me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "The caller's own listing",
    description:
      '404 when they have none, which is how the home screen knows to show the mode cards.',
  })
  async me(@CurrentUserId() userId: string) {
    const data = await this.listings.findMine(userId);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Listing') };
  }

  @Get('me/dashboard')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The professional dashboard',
    description:
      '`agreedTotal` is the sum of amounts the two parties agreed, not money Circl holds, owes or ' +
      'has paid. There is no balance, payout or fee anywhere in this payload.',
  })
  async dashboard(@CurrentUserId() userId: string) {
    const data = await this.home.dashboard(userId);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Dashboard') };
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Browse professionals',
    description:
      '`listingType=BOTH` merges professional listings and community offers into one result set, ' +
      'each carrying its own `type`. On an empty result, `meta.nearbyCityMatches` tells the client ' +
      'where widening would actually help.',
  })
  async list(@CurrentUserId() userId: string, @Query() query: BrowseProfessionalsDto) {
    const { data, meta } = await this.browse.browse(userId, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Professionals') };
  }

  // ─── Listings (2.6) ────────────────────────────────────────────────────────

  @Post('listings')
  @Idempotent()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a professional listing',
    description:
      'Does not accept name, phone, email, gender, avatar or country of origin — they are on the ' +
      'user record, and accepting them invites the client to ask for them again.',
  })
  async createListing(@CurrentUserId() userId: string, @Body() dto: CreateListingDto) {
    const data = await this.listings.create(userId, dto);

    return { data, message: SuccessMessage.RESOURCE_CREATED('Listing') };
  }

  @Post('listings/from-offer/:offerId')
  @Idempotent()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Promote a community offer into a listing',
    description:
      'A member who already posted "I can help with UK visa paperwork" has written the listing. ' +
      'Title, description, city, delivery mode and price copy across; the offer stays live until ' +
      'the listing is verified.',
  })
  async promoteOffer(
    @CurrentUserId() userId: string,
    @Param('offerId') offerId: string,
    @Body() dto: PromoteOfferDto,
  ) {
    const data = await this.listings.promoteOffer(userId, offerId, dto);

    return { data, message: SuccessMessage.RESOURCE_CREATED('Listing') };
  }

  @Patch('listings/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Edit a listing, or save a draft between steps' })
  async updateListing(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateListingDto,
  ) {
    const data = await this.listings.update(userId, id, dto);

    return { data, message: SuccessMessage.RESOURCE_UPDATED('Listing') };
  }

  @Patch('listings/:id/availability')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Turn work on or off', description: 'One field, two screens.' })
  async setAvailability(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: AvailabilityDto,
  ) {
    const data = await this.listings.setAvailability(userId, id, dto);

    return { data, message: SuccessMessage.RESOURCE_UPDATED('Listing') };
  }

  // ─── Services (2.6.3) ──────────────────────────────────────────────────────

  @Post('listings/:id/services')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a service' })
  async addService(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: ServiceDto,
  ) {
    const data = await this.listings.addService(userId, id, dto);

    return { data, message: SuccessMessage.RESOURCE_CREATED('Service') };
  }

  @Patch('listings/:id/services/:serviceId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Edit a service, including its availability toggle' })
  async updateService(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Param('serviceId') serviceId: string,
    @Body() dto: UpdateServiceDto,
  ) {
    const data = await this.listings.updateService(userId, id, serviceId, dto);

    return { data, message: SuccessMessage.RESOURCE_UPDATED('Service') };
  }

  @Delete('listings/:id/services/:serviceId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove a service',
    description:
      'A service with bookings against it is deactivated rather than deleted, or the booking loses ' +
      'its own subject. `removed` says which happened.',
  })
  async removeService(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Param('serviceId') serviceId: string,
  ) {
    const data = await this.listings.removeService(userId, id, serviceId);

    return { data, message: SuccessMessage.RESOURCE_DELETED('Service') };
  }

  @Put('listings/:id/services')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Replace the whole service set',
    description: "The manage panel's bulk save.",
  })
  async replaceServices(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: ReplaceServicesDto,
  ) {
    const data = await this.listings.replaceServices(userId, id, dto);

    return { data, message: SuccessMessage.RESOURCE_UPDATED('Services') };
  }

  // ─── Profile (2.4) — last, because :id is the catch-all ────────────────────

  @Get('listings/:listingId/slots')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'When this professional can actually be booked',
    description:
      'The working week minus what is already booked or blocked out. An unavailable slot is sent ' +
      'with a reason rather than omitted, so the member can see the professional is busy instead ' +
      'of assuming they do not work then. An empty `days` is a valid answer and the screen falls ' +
      'back to "I am flexible" only.',
  })
  async slots(@Param('listingId') listingId: string, @Query() query: ListSlotsDto) {
    const { data } = await this.availability.slots(listingId, query);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Availability') };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'A professional profile',
    description:
      "Accepts either a listing id or the professional's user id, so a link from a community post, " +
      'a message thread or a review resolves without the client having to know which id it holds.',
  })
  async profile(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.browse.profile(userId, id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Professional') };
  }
}
