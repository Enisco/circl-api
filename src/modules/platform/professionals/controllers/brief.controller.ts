import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId, Idempotent, JwtAuthGuard, SuccessMessage } from '@/common';
import { ChooseMatchDto, CreateBriefDto } from '../dtos/booking.dto';
import { BriefService } from '../services/brief.service';

@Controller('professionals/briefs')
@ApiTags('Professionals · Circl Handle It')
@UseGuards(JwtAuthGuard)
export class BriefController {
  constructor(private readonly briefs: BriefService) {}

  @Post()
  @Idempotent()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Write a brief',
    description: '"Let Circl handle it". Written once, and it survives into the booking.',
  })
  async create(@CurrentUserId() userId: string, @Body() dto: CreateBriefDto) {
    const data = await this.briefs.create(userId, dto);

    return { data, message: SuccessMessage.RESOURCE_CREATED('Brief') };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'A brief' })
  async findOne(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.briefs.findOne(userId, id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Brief') };
  }

  @Get(':id/matches')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The three matches',
    description:
      'Scored on rating, distance, price fit and response time, each 0..1 with a one-word ' +
      'qualifier computed server-side so the bars and their labels agree everywhere. Zero matches ' +
      'returns `fallback: MANUAL_PLACEMENT` rather than an empty screen.',
  })
  async matches(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.briefs.matches(userId, id);

    return { data, message: 'Matches found' };
  }

  @Post(':id/choose')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Choose a match',
    description:
      'Creates the booking from the brief and returns it. Do not also call POST /bookings.',
  })
  async choose(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: ChooseMatchDto,
  ) {
    const data = await this.briefs.choose(userId, id, dto);

    return { data, message: SuccessMessage.RESOURCE_CREATED('Booking') };
  }

  @Post(':id/manual-placement')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Ask a human',
    description:
      'The fallback the managed promise implies. Opens a Circl-team thread with the brief attached.',
  })
  async manualPlacement(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.briefs.manualPlacement(userId, id);

    return { data, message: 'Our team will take it from here' };
  }
}
