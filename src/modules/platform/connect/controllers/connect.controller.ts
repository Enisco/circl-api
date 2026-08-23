import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId, JwtAuthGuard, SuccessMessage } from '@/common';
import {
  CreateConnectionRequestDto,
  DeclineRequestDto,
  DiscoveryDto,
  ListConnectionRequestsDto,
  UpsertConnectProfileDto,
} from '../dtos/connect.dto';
import { ConnectProfileService } from '../services/connect-profile.service';
import { ConnectionRequestService } from '../services/connection-request.service';
import { DiscoveryService } from '../services/discovery.service';

@Controller('connect')
@ApiTags('Connect')
@UseGuards(JwtAuthGuard)
export class ConnectController {
  constructor(
    private readonly profiles: ConnectProfileService,
    private readonly discovery: DiscoveryService,
    private readonly requests: ConnectionRequestService,
  ) {}

  // ─── Profile (3.2, 3.3) ────────────────────────────────────────────────────

  @Get('setup/prefill')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Everything the setup form already knows',
    description:
      'Call before rendering the form. `asks` lists the fields it must collect — when the member ' +
      'already has a date of birth, DATE_OF_BIRTH is absent and the form shows no age input at all.',
  })
  async setupPrefill(@CurrentUserId() userId: string) {
    const data = await this.profiles.setupPrefill(userId);

    return { data, message: 'Prefill loaded' };
  }

  @Get('me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'My Connect profile',
    description:
      '`hasProfile: false` with `profile: null` is a normal response, not a 404 — it is what the ' +
      'reciprocity gate renders against. `pendingRequestCount` backs the discovery banner.',
  })
  async me(@CurrentUserId() userId: string) {
    const data = await this.profiles.me(userId);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Connect profile') };
  }

  @Put('me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Create or edit my Connect profile',
    description:
      'One idempotent upsert, because setup and edit are the same screen. Languages, interests and ' +
      'heritage write through to the USER record rather than to a Connect-only copy — these also ' +
      'shape the feed. Does not accept name, age as a number, avatar, country or journey stage.',
  })
  async upsert(@CurrentUserId() userId: string, @Body() dto: UpsertConnectProfileDto) {
    const data = await this.profiles.upsert(userId, dto);

    return { data, message: SuccessMessage.RESOURCE_UPDATED('Connect profile') };
  }

  @Delete('me')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Leave Connect',
    description:
      'Removes the profile and all pending requests in both directions. Existing conversations ' +
      'survive, because a conversation belongs to two people rather than to a section — and this ' +
      'does not touch interests, languages, heritage or date of birth, which were never Connect\'s ' +
      'to own.',
  })
  async remove(@CurrentUserId() userId: string) {
    await this.profiles.remove(userId);
  }

  // ─── Requests (3.5) — declared before /profiles/:id ────────────────────────

  @Post('requests')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Send a connection request',
    description:
      'An open inbox returns 422 DIRECT_MESSAGE_ALLOWED with the conversation id, because sending ' +
      'a request there is a wasted step. Rate limited to 20 a day; a declined pair has a 30-day ' +
      'cooldown.',
  })
  async createRequest(
    @CurrentUserId() userId: string,
    @Body() dto: CreateConnectionRequestDto,
  ) {
    const data = await this.requests.create(userId, dto);

    return { data, message: 'Request sent' };
  }

  @Get('requests')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Received and sent requests', description: 'Both tabs read this.' })
  async listRequests(
    @CurrentUserId() userId: string,
    @Query() query: ListConnectionRequestsDto,
  ) {
    const { data, meta } = await this.requests.list(userId, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Requests') };
  }

  @Post('requests/:id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept a request',
    description: 'Creates the conversation and returns its id, so the client opens the chat directly.',
  })
  async accept(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.requests.accept(userId, id);

    return { data, message: 'Connected' };
  }

  @Post('requests/:id/decline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Decline a request',
    description: 'Silent: the sender is not told why. `alsoBlock` applies the block in the same transaction.',
  })
  async decline(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: DeclineRequestDto,
  ) {
    const data = await this.requests.decline(userId, id, dto);

    return { data, message: 'Request declined' };
  }

  @Delete('requests/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw a request you sent' })
  async cancel(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.requests.cancel(userId, id);

    return { data, message: 'Request withdrawn' };
  }

  // ─── Discovery (3.4) ───────────────────────────────────────────────────────

  @Get('profiles')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The discovery grid',
    description:
      'Reciprocity is enforced here: a member with no visible profile gets 403 ' +
      'CONNECT_PROFILE_REQUIRED. `meta.facets` returns the languages and heritage that people in ' +
      'this result actually have, so a filter can never guarantee an empty result.',
  })
  async discover(@CurrentUserId() userId: string, @Query() query: DiscoveryDto) {
    const { data, meta } = await this.discovery.discover(userId, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Profiles') };
  }

  @Get('profiles/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Another member's Connect profile",
    description:
      'Accepts a Connect profile id or the person\'s user id. Hidden, deleted and blocked all ' +
      'return the same 404: telling someone they have been blocked is itself a safety problem.',
  })
  async findOne(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.discovery.findOne(userId, id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Profile') };
  }
}
