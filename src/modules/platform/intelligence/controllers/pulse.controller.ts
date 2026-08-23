import { Controller, Get, HttpCode, HttpStatus, Param, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SuggestionSurface } from '@prisma/client';
import { CurrentUserId, JwtAuthGuard, SuccessMessage } from '@/common';
import { PrismaService } from '@/infrastructure';
import { DemandService } from '../services/demand.service';
import { MetricPeriod, MetricSection, MetricsService } from '../services/metrics.service';

@Controller('pulse')
@ApiTags('Circl Intelligence · Pulse')
@UseGuards(JwtAuthGuard)
export class PulseController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly demand: DemandService,
    private readonly database: PrismaService,
  ) {}

  @Get('suggestions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Guided Creation: what is in demand near you',
    description:
      'The suggestion shown while a member creates a post, service or product. Every reason names ' +
      'a real count and a real place, and the endpoint returns an empty array when the data does ' +
      'not support a claim — a fabricated signal that leads someone to stock or offer the wrong ' +
      'thing is worse than no card.',
  })
  @ApiQuery({ name: 'surface', enum: SuggestionSurface })
  @ApiQuery({ name: 'cityId', required: false })
  @ApiQuery({
    name: 'exclude',
    required: false,
    description: 'Comma list of codes already covered.',
  })
  async suggestions(
    @CurrentUserId() userId: string,
    @Query('surface') surface: SuggestionSurface,
    @Query('cityId') cityId?: string,
    @Query('exclude') exclude?: string,
  ) {
    const profile = await this.database.userProfile.findUnique({
      where: { userId },
      select: { cityId: true },
    });

    const data = await this.demand.suggestionsFor({
      surface,
      cityId: cityId ?? profile?.cityId ?? null,
      excludeCodes: exclude
        ? exclude
            .split(',')
            .map(code => code.trim())
            .filter(Boolean)
        : [],
    });

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Suggestions') };
  }

  @Get(':section')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'A section dashboard',
    description:
      'The Metrics Dashboard each section renders. One engine, four views — the same behavioural ' +
      'data as top items, top professionals, average prices, demand trends and most-searched ' +
      'keywords. Buckets counting people are suppressed below 20 rather than rounded (D19), and ' +
      'the thresholds ship in the response so an empty list reads as "too few to publish" rather ' +
      'than "nothing happened".',
  })
  @ApiQuery({ name: 'cityId', required: false })
  @ApiQuery({ name: 'period', required: false, enum: ['WEEK', 'MONTH', 'ALL_TIME'] })
  async dashboard(
    @CurrentUserId() userId: string,
    @Param('section') section: MetricSection,
    @Query('cityId') cityId?: string,
    @Query('period') period?: MetricPeriod,
  ) {
    const profile = await this.database.userProfile.findUnique({
      where: { userId },
      select: { cityId: true },
    });

    const data = await this.metrics.dashboard(
      section.toUpperCase() as MetricSection,
      cityId === 'ALL' ? null : (cityId ?? profile?.cityId ?? null),
      period ?? 'MONTH',
    );

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Pulse') };
  }
}
