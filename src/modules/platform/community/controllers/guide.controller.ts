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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DeflectionOutcome } from '@prisma/client';
import { CurrentUserId, Idempotent, JwtAuthGuard, SuccessMessage, RateLimit } from '@/common';
import {
  CreateGuideDto,
  GuideDeflectionDto,
  GuideFeedbackDto,
  GuideMatchDto,
  GuideProgressDto,
  ListGuidesDto,
} from '../dtos/guide.dto';
import { GuideService } from '../services/guide.service';
import { GuideMatchService } from '../services/guide-match.service';

@ApiBearerAuth()
@Controller('community/guides')
@ApiTags('Community · Guides')
@UseGuards(JwtAuthGuard)
export class GuideController {
  constructor(
    private readonly guides: GuideService,
    private readonly matcher: GuideMatchService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List guides',
    description:
      'Backs the three strips on the Guides tab through `section`. CONTINUE_READING may be empty, ' +
      'in which case the client hides the strip.',
  })
  async list(@CurrentUserId() userId: string, @Query() query: ListGuidesDto) {
    const { data, meta } = await this.guides.list(userId, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Guides') };
  }

  /** Declared before `:id` so "match" is never captured as a guide id. */
  @Post('match')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Does a guide already answer this?',
    description:
      'The "Before you post" interstitial. At most 2 matches at confidence >= 0.8; below that the ' +
      'client posts straight through without ever showing the screen. This call sits between the ' +
      'member tapping Post and their post existing, so it never blocks a post: if it is slow or ' +
      'errors, the client posts anyway.',
  })
  async match(@Body() dto: GuideMatchDto) {
    const data = await this.matcher.match(dto);

    return { data, message: 'Matches found' };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Guide detail',
    description:
      'Returns both `blocks` (the storage form) and `steps` (a flat projection of the STEP blocks) ' +
      'so the client can move to blocks without a migration. Machine-drafted guides carry their ' +
      'provenance, which is required rather than optional.',
  })
  async findOne(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.guides.findOne(userId, id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Guide') };
  }

  @Post()
  @Idempotent()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Write a guide',
    description:
      'A guide is steps, not free prose: send `steps`, and the server stores them as positioned '+
      'blocks.',
  })
  @RateLimit('CREATE')
  async create(@CurrentUserId() userId: string, @Body() dto: CreateGuideDto) {
    const data = await this.guides.create(userId, dto);

    return { data, message: SuccessMessage.RESOURCE_CREATED('Guide') };
  }

  @Put(':id/progress')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Save read progress',
    description: 'Powers Continue reading and the progress bar. Progress only moves forward.',
  })
  async setProgress(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: GuideProgressDto,
  ) {
    const data = await this.guides.setProgress(userId, id, dto);

    return { data, message: 'Progress saved' };
  }

  @Post(':id/bookmark')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bookmark a guide',
    description: 'Saves it to the member\'s own list. Idempotent.',
  })
  @RateLimit('REACT')
  async bookmark(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.guides.setBookmark(userId, id, true);

    return { data, message: 'Guide bookmarked' };
  }

  @Delete(':id/bookmark')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove a bookmark',
    description: 'Idempotent: removing one that was never saved succeeds.',
  })
  @RateLimit('REACT')
  async unbookmark(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.guides.setBookmark(userId, id, false);

    return { data, message: 'Bookmark removed' };
  }

  @Post(':id/reactions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Like a guide',
    description: 'Drives the like count on the card and in the guide header. Idempotent.',
  })
  @RateLimit('REACT')
  async like(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.guides.react(userId, id, true);

    return { data, message: 'Reaction saved' };
  }

  @Delete(':id/reactions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove a like',
    description: 'Idempotent: removing a like that was never added succeeds.',
  })
  @RateLimit('REACT')
  async unlike(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.guides.react(userId, id, false);

    return { data, message: 'Reaction removed' };
  }

  @Post(':id/feedback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Was this useful?',
    description: 'One per member per guide, upserted on repeat.',
  })
  async feedback(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: GuideFeedbackDto,
  ) {
    const data = await this.guides.submitFeedback(userId, id, dto);

    return { data, message: 'Thanks for the feedback' };
  }

  @Post(':id/deflection')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Deflection telemetry',
    description:
      'Fire and forget, so the value of the interstitial is measurable. If members always post ' +
      'anyway, the screen is costing more than it saves.',
  })
  async deflection(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: GuideDeflectionDto,
  ) {
    await this.guides.recordDeflection(userId, id, dto.outcome as DeflectionOutcome);
  }
}
