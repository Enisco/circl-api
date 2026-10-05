import { Controller, Get, HttpCode, HttpStatus, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SuggestionSurface } from '@prisma/client';
import { ApiException, CurrentUserId, JwtAuthGuard, SuccessMessage } from '@/common';
import { PrismaService } from '@/infrastructure';
import { DemandService } from '../services/demand.service';
import { MetricPeriod, MetricSection, MetricsService } from '../services/metrics.service';
import { PULSE_FLOORS, PulseScope, PulseService } from '../services/pulse.service';
import {
  SEARCH_DEPTHS,
  SEARCH_FILTERS,
  SearchDemandService,
  SearchFilter,
} from '../services/search-demand.service';
import { CityService } from '../../shared';

@ApiBearerAuth()
@Controller('pulse')
@ApiTags('Circl Intelligence · Pulse')
@UseGuards(JwtAuthGuard)
export class PulseController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly demand: DemandService,
    private readonly database: PrismaService,
    private readonly pulse: PulseService,
    private readonly cities: CityService,
    private readonly searchDemand: SearchDemandService,
  ) {}

  @Get('search-demand')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'What people are searching for',
    description:
      'The three search lists the metrics view shows: what was searched for, what was searched ' +
      'for and **found nothing**, and what is rising fastest against the week before. Every list ' +
      'carries the window it covers and when it was built, because no number should sit without ' +
      'a date.\n\n' +
      'Counted, never attributed. A term is only published once **five different people** have ' +
      'searched it — not five searches, because one person typing the same thing five times ' +
      'would clear that, and a rare and specific search identifies whoever typed it however ' +
      'little is said about them. Anything carrying a number, an `@` or a link is dropped ' +
      'whatever the counts say.\n\n' +
      'Each row carries the term and the `code` it resolved to, so tapping it can run the ' +
      'ordinary search with that filter rather than guessing at one.',
  })
  @ApiQuery({ name: 'filter', required: false, enum: [...SEARCH_FILTERS] })
  @ApiQuery({ name: 'cityId', required: false, description: 'Omit for nationwide.' })
  @ApiQuery({ name: 'limit', required: false, enum: [...SEARCH_DEPTHS] })
  async searchDemandList(
    @Query('filter') filter?: string,
    @Query('cityId') cityId?: string,
    @Query('limit') limit?: string,
  ) {
    const chosen = (SEARCH_FILTERS as readonly string[]).includes(filter ?? 'ALL')
      ? ((filter ?? 'ALL') as SearchFilter)
      : 'ALL';
    const depth = Number(limit ?? SEARCH_DEPTHS[0]);

    if (cityId) await this.cities.assertValid(cityId);

    const data = await this.searchDemand.published(chosen, cityId ?? null, depth);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Search demand') };
  }

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

  @Get('raw/:section')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'A section dashboard, unshaped',
    description:
      'The raw metric snapshots behind Pulse, kept for admin and debugging. The member-facing ' +
      'contract is GET /pulse/{scope} (6.2); this is the engine underneath it, and it names its ' +
      'suppression thresholds so an empty list reads as "too few to publish" rather than ' +
      '"nothing happened".',
  })
  @ApiQuery({ name: 'cityId', required: false })
  @ApiQuery({ name: 'period', required: false, enum: ['WEEK', 'MONTH', 'ALL_TIME'] })
  async raw(
    @CurrentUserId() userId: string,
    @Param('section') section: MetricSection,
    @Query('cityId') cityId?: string,
    @Query('period') period?: MetricPeriod,
  ) {
    const data = await this.metrics.dashboard(
      section.toUpperCase() as MetricSection,
      cityId === 'ALL' ? null : await this.cityFor(userId, cityId),
      period ?? 'MONTH',
    );

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Pulse') };
  }

  @Get(':scope')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'A Pulse dashboard',
    description:
      "Aggregate only, and it never names anybody (D34). Below the scope's floor the shape " +
      'comes back with empty arrays rather than a chart drawn from four people, and the real ' +
      'contributingMembers is kept so a suppressed dashboard is debuggable (6.2.1).',
  })
  @ApiQuery({ name: 'cityId', required: false })
  @ApiQuery({ name: 'period', required: false, enum: ['WEEK', 'MONTH', 'ALL_TIME'] })
  async dashboard(
    @CurrentUserId() userId: string,
    @Param('scope') scope: string,
    @Query('cityId') cityId?: string,
    @Query('period') period?: MetricPeriod,
  ) {
    const key = scope.toLowerCase() as PulseScope;

    if (!PULSE_FLOORS[key]) {
      throw ApiException.notFound(`"${scope}" is not a Pulse dashboard.`);
    }

    return this.pulse.dashboard(
      key,
      cityId === 'ALL' ? null : await this.cityFor(userId, cityId),
      period ?? 'MONTH',
    );
  }

  /** 1.0.3 applies here, and Pulse is the one place where getting it wrong is silent: an unresolved city returns an empty dashboard, which the client renders as "not enough activity yet" rather than as an error (6.2). */
  private async cityFor(userId: string, cityId?: string): Promise<string | null> {
    const resolved = cityId ? await this.cities.resolve(cityId) : null;

    if (resolved) return resolved.id;

    const profile = await this.database.userProfile.findUnique({
      where: { userId },
      select: { cityId: true },
    });

    return profile?.cityId ?? null;
  }
}
