import { Controller, Get, HttpCode, HttpStatus, Param, Query, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { JoinPolicy, PostVisibility, RequestStatus } from '@prisma/client';
import { ApiErrorCode, ApiException, CsvArray, CurrentUser, SuccessMessage } from '@/common';
import { AdminJwtGuard } from '@/common/guards/admin-jwt.guard';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AdminBffGuard } from '../common/admin-bff.guard';
import { AdminPermissionGuard } from '../common/admin-permission.guard';
import { AdminAnyPermission, AdminAuthenticated, AdminPrincipal } from '../common/admin-principal';
import {
  ANALYTICS_TABS,
  AnalyticsTab,
  DashboardFilterDto,
  POPULATIONS,
  PopulationMode,
} from '../dtos/admin-analytics.dto';
import { AnalyticsFilterDto } from '../dtos/analytics-filter.dto';
import { AdminAnalyticsService } from '../services/admin-analytics.service';
import { AdminDashboardService } from '../services/admin-dashboard.service';

/** The shared filter, plus the chart selector the portal uses to lazy-load and re-fetch one chart. */
class AnalyticsTabQueryDto extends AnalyticsFilterDto {
  @ApiPropertyOptional({
    description: 'Limit the response to these chart ids. An unknown id is a 400, never silence.',
  })
  @CsvArray()
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  @IsOptional()
  charts?: string[];

  @ApiPropertyOptional({ description: 'Community: `COMMUNITY_CATEGORY` codes.' })
  @CsvArray()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  @IsOptional()
  categories?: string[];

  @ApiPropertyOptional({ description: 'Community: `GUIDE_TOPIC` codes.' })
  @CsvArray()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  @IsOptional()
  guideTopics?: string[];

  @ApiPropertyOptional({ enum: RequestStatus, isArray: true, description: 'Community.' })
  @CsvArray()
  @IsArray()
  @ArrayMaxSize(8)
  @IsIn(Object.values(RequestStatus), { each: true })
  @IsOptional()
  requestStatuses?: string[];

  @ApiPropertyOptional({ enum: PostVisibility, isArray: true, description: 'Community.' })
  @CsvArray()
  @IsArray()
  @ArrayMaxSize(4)
  @IsIn(Object.values(PostVisibility), { each: true })
  @IsOptional()
  visibility?: string[];

  @ApiPropertyOptional({ enum: JoinPolicy, isArray: true, description: 'Community: groups.' })
  @CsvArray()
  @IsArray()
  @ArrayMaxSize(4)
  @IsIn(Object.values(JoinPolicy), { each: true })
  @IsOptional()
  joinPolicy?: string[];

  @ApiPropertyOptional({
    enum: POPULATIONS,
    default: 'all',
    description: 'Demographics only: everybody as of `to`, or only those who joined in the range.',
  })
  @IsOptional()
  @IsIn(POPULATIONS as unknown as string[])
  population?: PopulationMode;
}

@ApiExcludeController()
@ApiTags('Admin · Analytics')
@Controller('admin')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminAnalyticsController {
  constructor(
    private readonly analytics: AdminAnalyticsService,
    private readonly dashboard: AdminDashboardService,
  ) {}

  // ─── Dashboard (§5.24) ─────────────────────────────────────────────────────

  @Get('dashboard/kpis')
  @AdminAuthenticated()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The headline numbers this caller may see',
    description:
      'Widgets follow permissions, not roles, and a widget the caller may not see is **omitted** ' +
      'rather than nulled — a card showing a dash leaves a staff member wondering whether the ' +
      'number is zero or whether they are not allowed to see it.',
  })
  async kpis(@CurrentUser() actor: AdminPrincipal, @Query() query: DashboardFilterDto) {
    const data = await this.dashboard.kpis(actor, query);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Dashboard') };
  }

  @Get('dashboard/attention')
  @AdminAuthenticated()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'What needs somebody now',
    description:
      'Fixed ids and fixed portal paths — the portal matches on the id and navigates to the ' +
      '`href`, so each count equals the default list of the page it opens. A badge saying seven ' +
      'that leads to a page showing four is worse than no badge.\\n\\n' +
      'Zero is omitted, not shown: a list of twelve zeroes is a list nobody reads. Sorted by ' +
      'severity then by count.',
  })
  async attention(@CurrentUser() actor: AdminPrincipal) {
    const data = await this.dashboard.attention(actor);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Attention') };
  }

  @Get('dashboard/charts')
  @AdminAnyPermission('analytics:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The four dashboard charts',
    description:
      'The same computations as the Overview tab, from the same cache entries — so the dashboard ' +
      'and the tab cannot disagree about a number the reader just saw on the other page.',
  })
  async charts(@Query() query: DashboardFilterDto) {
    const { data, meta } = await this.dashboard.charts(query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Charts') };
  }

  @Get('dashboard/staff-activity')
  @AdminAnyPermission('audit:read', 'audit:read_area', 'audit:read_self')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The last twenty things staff did',
    description: 'Scoped per R8, applied in the query. A `audit:read_self` holder sees their own.',
  })
  async staffActivity(@CurrentUser() actor: AdminPrincipal) {
    const data = await this.dashboard.staffActivity(actor);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Activity') };
  }

  // ─── Analytics tabs (§5.25) ────────────────────────────────────────────────

  @Get('analytics/:tab')
  @AdminAnyPermission('analytics:read', 'analytics:safety')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Every chart of one tab',
    description:
      'Takes the shared member filter (§2.5). `charts=` narrows the response, so the portal can ' +
      'lazy-load a tab and re-fetch one chart when its own date selector moves.\\n\\n' +
      'One failed chart is returned as `{ kind: "error", code }` in its own slot rather than ' +
      'failing the tab: a dashboard that goes blank because a single query timed out is a ' +
      'dashboard nobody trusts.\\n\\n' +
      'Suppression (§2.7) is applied before caching, so a cached payload is already safe for ' +
      'anybody with the tab\\u2019s permission. Where the filters select fewer than ten members, ' +
      '**every** number is withheld and `meta.populationSuppressed` says so.',
  })
  async tab(
    @CurrentUser() actor: AdminPrincipal,
    @Param('tab') tab: string,
    @Query() query: AnalyticsTabQueryDto,
  ) {
    if (!(ANALYTICS_TABS as readonly string[]).includes(tab)) {
      throw ApiException.badRequest(ApiErrorCode.VALIDATION_FAILED, `No such tab: ${tab}.`);
    }

    const { data, meta } = await this.analytics.tab(
      actor,
      tab as AnalyticsTab,
      query,
      query.charts,
      query.population,
      {
        categories: query.categories,
        guideTopics: query.guideTopics,
        requestStatuses: query.requestStatuses,
        visibility: query.visibility,
        joinPolicy: query.joinPolicy,
      },
    );

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Analytics') };
  }
}
