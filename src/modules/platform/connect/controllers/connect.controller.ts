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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId, JwtAuthGuard, RateLimit, SuccessMessage } from '@/common';
import {
  CreateConnectionRequestDto,
  CreateConnectPostDto,
  CreateConnectStoryDto,
  DeclineRequestDto,
  DiscoveryDto,
  ListConnectionRequestsDto,
  ReorderPostsDto,
  UpdateConnectPostDto,
  UpsertConnectProfileDto,
  UpsertPromptsDto,
} from '../dtos/connect.dto';
import { ConnectProfileService } from '../services/connect-profile.service';
import { ConnectionRequestService } from '../services/connection-request.service';
import { ConnectMediaService } from '../services/connect-media.service';
import { DiscoveryService } from '../services/discovery.service';

@ApiBearerAuth()
@Controller('connect')
@ApiTags('Connect')
@UseGuards(JwtAuthGuard)
export class ConnectController {
  constructor(
    private readonly profiles: ConnectProfileService,
    private readonly discovery: DiscoveryService,
    private readonly requests: ConnectionRequestService,
    private readonly connectMedia: ConnectMediaService,
  ) {}

  // ─── 3.2 Posts ─────────────────────────────────────────────────────────────

  @Post('me/posts')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Add a post',
    description:
      '**Every key in one call is one post**, in the order given: the grouping is the call, not ' +
      'the upload. Up to 9 posts per profile, 5 photos per photo post, exactly 1 video per video ' +
      'post, and never a mix. A video also needs `posterKey` — nothing here derives a frame from ' +
      'a clip, and a video handed to an image loader is a grey square. Appended at the end.',
  })
  @RateLimit('CREATE')
  async createPost(@CurrentUserId() userId: string, @Body() dto: CreateConnectPostDto) {
    const own = await this.profiles.requireOwn(userId);
    const data = await this.connectMedia.createPost(own.id, userId, dto);

    return { data, message: 'Post added' };
  }

  @Patch('me/posts/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Change a post\'s caption',
    description: 'Answers the single post, which is what the client renders rather than re-fetching.',
  })
  async updatePost(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateConnectPostDto,
  ) {
    const own = await this.profiles.requireOwn(userId);
    const data = await this.connectMedia.updatePost(own.id, id, dto);

    return { data, message: 'Post updated' };
  }

  @Delete('me/posts/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a post', description: 'Takes its items with it.' })
  async removePost(@CurrentUserId() userId: string, @Param('id') id: string) {
    const own = await this.profiles.requireOwn(userId);

    await this.connectMedia.removePost(own.id, id);
  }

  @Delete('me/posts/:postId/media/:mediaId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove one photo from a post',
    description:
      'Answers the post without it. Removing the last item removes the post and answers `null`: ' +
      'an empty post is not a post, and the grid cannot draw one.',
  })
  async removePostItem(
    @CurrentUserId() userId: string,
    @Param('postId') postId: string,
    @Param('mediaId') mediaId: string,
  ) {
    const own = await this.profiles.requireOwn(userId);
    const data = await this.connectMedia.removePostItem(own.id, postId, mediaId);

    return { data, message: data ? 'Photo removed' : 'Post removed' };
  }

  @Put('me/posts/order')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reorder the gallery',
    description:
      'The whole list in the new order. Refused unless the ids are exactly this profile\'s ' +
      'posts, once each, so a stale client cannot drop one by leaving it out. Answers the list ' +
      'with `position` renumbered from zero — a stale position is how a gallery draws the wrong ' +
      'face first.',
  })
  async reorderPosts(@CurrentUserId() userId: string, @Body() dto: ReorderPostsDto) {
    const own = await this.profiles.requireOwn(userId);
    const data = await this.connectMedia.reorderPosts(own.id, dto);

    return { data: { posts: data }, message: 'Gallery reordered' };
  }

  // ─── 3.3 Prompts ───────────────────────────────────────────────────────────

  @Get('prompts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The questions a profile can answer',
    description:
      'Served like any other taxonomy, so the questions can be reworded without a release. The ' +
      'same list travels on `GET /taxonomy` as `connectPrompts`.',
  })
  async prompts() {
    const data = await this.connectMedia.prompts();

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Prompts') };
  }

  @Put('me/prompts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Answer the prompts',
    description:
      'The whole set, max 3, which keeps the order the owner chose. An empty array clears them. ' +
      'The question is not stored: it travels with the answer on read, so a rewording never ' +
      'silently changes what somebody said.',
  })
  async setPrompts(@CurrentUserId() userId: string, @Body() dto: UpsertPromptsDto) {
    const own = await this.profiles.requireOwn(userId);
    const data = await this.connectMedia.setPrompts(own.id, dto);

    return { data: { prompts: data }, message: 'Prompts saved' };
  }

  // ─── 3.4 Stories ───────────────────────────────────────────────────────────

  @Get('stories')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Live stories',
    description:
      'Everybody this caller may see who has a live story, following the discovery rules exactly ' +
      '— same visibility, same reciprocity gate, same blocks. One row per person **including the ' +
      'caller**, whose own row is the "Your story" tile. Unseen first, then newest. Expired items ' +
      'are simply absent; there are no tombstones.',
  })
  async stories(@CurrentUserId() userId: string) {
    const data = await this.connectMedia.stories(userId);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Stories') };
  }

  @Post('stories')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Post a story',
    description:
      'Up to 10 live at once. `expiresAt` is stamped here and never sent by the client: the ' +
      'viewer counts down against it, and a drifted device clock is the one thing that would ' +
      'show somebody a story that is already gone. A video takes the same 60-second cap and the ' +
      'same optional `posterKey` as a post.',
  })
  @RateLimit('CREATE')
  async createStory(@CurrentUserId() userId: string, @Body() dto: CreateConnectStoryDto) {
    const own = await this.profiles.requireOwn(userId);
    const data = await this.connectMedia.createStory(own.id, userId, dto);

    return { data, message: 'Story posted' };
  }

  @Post('stories/:id/seen')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a story seen', description: 'Idempotent, one call per item.' })
  async markStorySeen(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.connectMedia.markStorySeen(userId, id);

    return { data, message: 'Seen' };
  }

  @Delete('stories/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Take a story down early',
    description: 'The owner only. It vanishes from every other reader on their next load.',
  })
  async removeStory(@CurrentUserId() userId: string, @Param('id') id: string) {
    const own = await this.profiles.requireOwn(userId);

    await this.connectMedia.removeStory(own.id, id);
  }

  // ─── Profile (3.2, 3.3) ────────────────────────────────────────────────────

  @Get('setup/prefill')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Everything the setup form already knows',
    description:
      'Call before rendering the form. `asks` lists the fields it must collect — when the member ' +
      'already has a date of birth, DATE_OF_BIRTH is absent and the form shows no age input at ' +
      'all.\n\n' +
      '**`prefill.isVisible` is what the toggle should show**, which for a member with no profile ' +
      'yet is what the server will do if they never touch it: `true`. Not the same question as ' +
      '`GET /connect/me`\u2019s `isVisible`, which is a statement of fact about now and is `false` ' +
      'for somebody with no profile, because they are not discoverable. Render the switch from ' +
      'this one; a screen that hardcodes its own default agrees with the server only by luck.',
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
      'reciprocity gate renders against. `pendingRequestCount` backs the discovery banner.\n\n' +
      '**`isVisible` here is a statement of fact about now**, so it is `false` for a member with ' +
      'no profile: they are not discoverable, because there is nothing to discover. The setup ' +
      'form\u2019s toggle reads `prefill.isVisible` from `GET /connect/setup/prefill` instead, ' +
      'which answers what the server will do if the member never touches it.',
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
      'shape the feed. Does not accept name, age as a number, avatar, country or journey stage.\n\n' +
      '**A full replace, not a patch.** `typeCode` and `lookingFor` are required on every call, so ' +
      'flipping `isVisible` on its own means resending the profile. `GET /connect/setup/prefill` ' +
      'returns `prefill.isVisible` so the toggle can render without a second call.',
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
      "does not touch interests, languages, heritage or date of birth, which were never Connect's " +
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
  async createRequest(@CurrentUserId() userId: string, @Body() dto: CreateConnectionRequestDto) {
    const data = await this.requests.create(userId, dto);

    return { data, message: 'Request sent' };
  }

  @Get('requests')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Received and sent requests', description: 'Both tabs read this.' })
  async listRequests(@CurrentUserId() userId: string, @Query() query: ListConnectionRequestsDto) {
    const { data, meta } = await this.requests.list(userId, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Requests') };
  }

  @Post('requests/:id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept a request',
    description:
      'Creates the conversation and returns its id, so the client opens the chat directly.',
  })
  async accept(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.requests.accept(userId, id);

    return { data, message: 'Connected' };
  }

  @Post('requests/:id/decline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Decline a request',
    description:
      'Silent: the sender is not told why. `alsoBlock` applies the block in the same transaction.',
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
  @ApiOperation({
    summary: 'Withdraw a request you sent',
    description: 'The sender takes it back. The recipient is never told it existed.',
  })
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
      "Accepts a Connect profile id or the person's user id. Hidden, deleted and blocked all " +
      'return the same 404: telling someone they have been blocked is itself a safety problem.',
  })
  async findOne(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.discovery.findOne(userId, id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Profile') };
  }
}
