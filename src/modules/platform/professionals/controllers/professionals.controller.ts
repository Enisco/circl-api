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
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUserId, Idempotent, JwtAuthGuard, SuccessMessage } from '@/common';
import { BrowseProfessionalsDto, ListSlotsDto } from '../dtos/browse.dto';
import { SlotsResponseDto } from '../dtos/slots-response.dto';
import {
  AvailabilityDto,
  CreateListingDto,
  PromoteOfferDto,
  ReplaceServicesDto,
  UpdateListingDto,
} from '../dtos/listing.dto';
import {
  CreateServiceDto,
  ListServicesDto,
  ServiceVisibilityDto,
  UpdateServiceDto as UpdateServiceV2Dto,
} from '../dtos/service.dto';
import { SubmitVerificationDto } from '../dtos/verification.dto';
import { BrowseService } from '../services/browse.service';
import { CategoryVerificationService } from '../services/category-verification.service';
import { ProfessionalSearchService } from '../services/professional-search.service';
import { ServiceCatalogueService } from '../services/service-catalogue.service';
import { ListingService } from '../services/listing.service';
import { ProfessionalsHomeService } from '../services/professionals-home.service';
import { AvailabilityService } from '../services/availability.service';

@ApiBearerAuth()
@Controller('professionals')
@ApiTags('Professionals')
@UseGuards(JwtAuthGuard)
export class ProfessionalsController {
  constructor(
    private readonly listings: ListingService,
    private readonly browse: BrowseService,
    private readonly home: ProfessionalsHomeService,
    private readonly availability: AvailabilityService,
    private readonly services: ServiceCatalogueService,
    private readonly verifications: CategoryVerificationService,
    private readonly search: ProfessionalSearchService,
  ) {}

  // ─── Fixed paths first, so they are never captured as an :id ───────────────

  @Get('home')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The Professionals home screen',
    description:
      'One call for six strips, because six round trips would show six spinners.\n\n' +
      '`myListing` is `null` for a member without one. Where there is one it carries ' +
      '`professionTitle`, `category`, `serviceCount`, `isAcceptingWork` and ' +
      '`verificationStatus` — the same names `GET /professionals/me` uses for the same things.\n\n' +
      '**`serviceCount` is the number, and the array is deliberately absent.** Do not read ' +
      '`services.length` here: an absent list is not an empty one, and reading it as zero tells a ' +
      'professional with a full price list to add their first service.\n\n' +
      '`title` is a deprecated alias of `professionTitle` and will be removed after one release.',
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
  @ApiOperation({
    summary: 'Edit a listing, or save a draft between steps',
    description:
      'Owner only. A listing stays live and UNVERIFIED throughout (D13); editing resubmits it ' +
      'for nothing.',
  })
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
  @ApiOperation({
    summary: 'Add a service',
    description:
      'A service is the thing members search and read (v2 §5): its own description, category, ' +
      'media, updates and milestones, and its own page.\n\n' +
      'The category gate is applied **here** and not taken from the client: a gated category with ' +
      'no approved verification is `403 VERIFICATION_REQUIRED`, carrying the category in `data`. ' +
      'A **pending** verification is not a refusal — the service is created with ' +
      '`status: PENDING_VERIFICATION` and is invisible to everybody but its owner.\n\n' +
      'Pricing is three decisions (SERVICE-PRICING). `pricingKind` is `FLAT` or `PACKAGES` and ' +
      'the two are exclusive; `packages[]` is the whole set in the professional’s own order, with ' +
      'no `id` on a create; and `consultationFeePence` is its own number, never folded into the ' +
      'price. On a `PACKAGES` write the server **recomputes** `price` from the cheapest package, ' +
      'so `pricePence` is a hint there and the authority on a `FLAT` one.',
  })
  async addService(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: CreateServiceDto,
  ) {
    const data = await this.services.create(userId, id, dto);

    return { data, message: SuccessMessage.RESOURCE_CREATED('Service') };
  }

  @Patch('listings/:id/services/:serviceId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Edit a service',
    description:
      'Owner only, and **absent is not empty** (v2 §5.5): a body carrying only `name` changes ' +
      'only the name, while `mediaKeys: []` clears the media. An edit that moves the service into ' +
      'a gated category is checked against *that* category.\n\n' +
      'An edit never rewrites what was already agreed: a booking copied the name, description and ' +
      'price when it was made (2.9.2).\n\n' +
      '`packages` follows the same whole-set rule as `mediaKeys`: a package kept by `id` keeps ' +
      'it, one left out is removed, `[]` clears the set and omitting the key leaves it alone. An ' +
      '`id` that is not on this service is `422`, naming it in `data.unknown`, rather than being ' +
      'ignored — ignoring it would remove a package the professional never touched. ' +
      '`consultationFeePence` distinguishes three cases: a number sets the fee, an explicit ' +
      '`null` removes it, and omitting the key leaves whatever is stored. Moving to ' +
      '`pricingKind: FLAT` clears the packages.',
  })
  async updateService(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Param('serviceId') serviceId: string,
    @Body() dto: UpdateServiceV2Dto,
  ) {
    const data = await this.services.update(userId, id, serviceId, dto);

    return { data, message: SuccessMessage.RESOURCE_UPDATED('Service') };
  }

  @Patch('listings/:id/services/:serviceId/visibility')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Show or hide a service',
    description:
      'Its own route because **showing must not override a verification** (v2 §5.5.1). A service ' +
      'whose category went back into review returns to `PENDING_VERIFICATION`, not to ' +
      '`PUBLISHED`, and only the server knows which. `isActive` is gone from the write body; ' +
      '`status` is the only answer.',
  })
  async setServiceVisibility(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Param('serviceId') serviceId: string,
    @Body() dto: ServiceVisibilityDto,
  ) {
    const data = await this.services.setVisibility(userId, id, serviceId, dto.isVisible);

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
  @ApiOkResponse({ type: SlotsResponseDto })
  async slots(@Param('listingId') listingId: string, @Query() query: ListSlotsDto) {
    const { data } = await this.availability.slots(listingId, query);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Availability') };
  }

  // ─── Services and verifications (v2 §2, §5, §6) ────────────────────────────
  //
  // All of these sit above `GET :id`, which would otherwise capture `services` and `search` as a
  // listing id: Nest matches in declaration order.

  @Post('me/verifications')
  @HttpCode(HttpStatus.ACCEPTED)
  @Idempotent()
  @ApiOperation({
    summary: 'Submit documents for a category',
    description:
      'One record per `(professional, category)` (v2 §2). **One approval covers the category** — ' +
      'every gated kind of work under it, for every service they list now or later.\n\n' +
      'May be called **before** any service exists in the category and before the category is on ' +
      'their profile: a professional should be able to get approved ahead of needing it. The same ' +
      'call is how a resubmission works after a decline, a revocation or an expiry; the previous ' +
      'documents are superseded rather than deleted, so the record of what a decision was made on ' +
      'survives.\n\n' +
      'Documents are uploaded first with `purpose: VERIFICATION` (PDF, PNG, JPEG or **HEIC**) and ' +
      'their ids sent here. No URL is ever returned for one.',
  })
  async submitVerification(@CurrentUserId() userId: string, @Body() dto: SubmitVerificationDto) {
    const data = await this.verifications.submit(userId, dto);

    return { data, message: 'Submitted for review' };
  }

  @Get('me/verifications')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'My category verifications',
    description:
      'Every record, in every state, with its document count. The same records the field on ' +
      '`GET /professionals/me` carries — two routes for one thing on purpose (v2 §2.5): the field ' +
      'saves the manage panel a call, and this lets the verification centre refresh after a ' +
      'submission without refetching the whole listing.',
  })
  async myVerifications(@CurrentUserId() userId: string) {
    const data = await this.verifications.forOwner(userId);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Verifications') };
  }

  @Get('search')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Services and professionals, in one answer',
    description:
      'Two result sets, each with its **own total match count** (v2 §6.1) — `Services · 124` is ' +
      'what tells somebody narrowing is worth it, so the count is the total and never the number ' +
      'returned.\n\n' +
      '`q` matches a service on its name and description, and a professional on their name, their ' +
      'profession title **and the names of their services**: searching "visa" surfaces somebody ' +
      'whose services are about visas even where the word is nowhere on their profile.\n\n' +
      'Filters apply to both groups, so narrowing never silently drops one. Narrowing goes to each ' +
      'type\u2019s own paged list.',
  })
  async blendedSearch(@CurrentUserId() userId: string, @Query() query: ListServicesDto) {
    const data = await this.search.blended(query, userId, query.groups);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Search') };
  }

  @Get('services')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Services, paged',
    description:
      'The narrowed half of §6.1, on its own cursor. Published services only — which is also what ' +
      'makes the count honest.',
  })
  async serviceList(@CurrentUserId() userId: string, @Query() query: ListServicesDto) {
    const { data, meta } = await this.services.search(query, userId);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Services') };
  }

  @Get('services/:serviceId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'A service’s public page',
    description:
      'Carries the professional, so the identity tile needs no second call (v2 §5.6). ' +
      '`viewer.isOwner` is on every read: it is what stops a professional being offered a ' +
      'conversation with themselves.\n\n' +
      '**`404` for anything not published, asked for by anybody but its owner** — not `403`. A ' +
      '`403` confirms the service exists, which is a disclosure about somebody’s pending ' +
      'verification.',
  })
  async serviceDetail(@CurrentUserId() userId: string, @Param('serviceId') serviceId: string) {
    const data = await this.services.detail(serviceId, userId);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Service') };
  }

  @Get(':listingId/services')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'A professional’s services, paged',
    description:
      'Published only, unless the owner is asking — then every status, so the manage panel can ' +
      'show a draft and a service waiting on a verification beside the live ones.',
  })
  async listingServices(
    @CurrentUserId() userId: string,
    @Param('listingId') listingId: string,
    @Query() query: ListServicesDto,
  ) {
    const { data, meta } = await this.services.forListing(listingId, userId, {
      skip: query.skip,
      take: query.take,
      currentPage: query.currentPage,
      perPage: query.perPage,
    });

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Services') };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'A professional profile',
    description:
      "Accepts either a listing id or the professional's user id, so a link from a community post, " +
      'a message thread or a review resolves without the client having to know which id it holds.\n\n' +
      'Carries three gathered arrays beside `services[]` — `serviceMedia`, `serviceUpdates` and ' +
      '`serviceMilestones` — each item naming the `serviceId` and `serviceName` it came from, with ' +
      'a `…Count` total beside it for what the cap left out. Media is in service order then the ' +
      "professional's own order within each service; updates are newest first across every " +
      "service; milestones keep the professional's order, never year, because they are claims " +
      'rather than a record. `services[]` and all three arrays carry only what the viewer may ' +
      'see: published services for a stranger, and the owner’s own draft, hidden and pending work ' +
      'for the owner.',
  })
  async profile(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.browse.profile(userId, id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Professional') };
  }
}
