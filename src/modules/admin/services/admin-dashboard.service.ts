import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { AnalyticsRunnerService } from '../analytics/analytics-runner.service';
import { Chart } from '../analytics/chart.types';
import { OverviewAnalytics } from '../analytics/overview.analytics';
import { POPULATION_FLOOR, suppressEverything } from '../analytics/suppression';
import { AdminPrincipal } from '../common/admin-principal';
import { MemberFilterBuilder, ResolvedMemberFilter } from '../filters/member-filter.builder';
import { DashboardFilterDto } from '../dtos/admin-analytics.dto';
import { AuditEntryView, auditScopeFor, toAuditEntry } from '../serializers/audit-entry.serializer';
import { staffRefSelect, toStaffRef } from '../serializers/admin-staff.serializer';
import { MediaService } from '@/modules/platform/shared';

export interface AttentionItem {
  id: string;
  label: string;
  count: number;
  oldestAt: string | null;
  severity: 'critical' | 'high' | 'normal';
  /** Portal-relative, and exactly the path the spec names: the portal ignores anything else. */
  href: string;
}

/**
 * The attention list (§5.24), as a table rather than as code.
 *
 * Fixed ids, fixed hrefs, fixed severities — the portal matches on the id and navigates to the
 * href, so an invented id is a row nobody can click and a hand-built href is a 404. Each row also
 * names the permission that gates it, because the list is filtered per caller: Trust & Safety and
 * Support open the same page and should see different things on it.
 *
 * The rule that makes the list trustworthy: **each count equals the default list of the page its
 * href opens.** A badge saying 7 that leads to a page showing 4 is worse than no badge.
 */
const ATTENTION: Array<{
  id: string;
  label: string;
  permission: string;
  severity: AttentionItem['severity'];
  href: string;
  count: (database: PrismaService) => Promise<{ count: number; oldestAt: Date | null }>;
}> = [
  {
    id: 'unclaimedUrgentReports',
    label: 'Unclaimed urgent reports',
    permission: 'moderation:read',
    severity: 'critical',
    href: '/trust-safety/reports?view=unassigned&priority=URGENT',
    count: database =>
      oldestAndCount(
        database,
        Prisma.sql`
        SELECT COUNT(*)::int AS count, MIN(q."created_at") AS oldest
        FROM "moderation_queue_items" q
        WHERE q."type" = 'REPORTED_CONTENT' AND q."state" = 'PENDING'
          AND q."assigned_to_id" IS NULL
          AND q."risk_level" IN ('HIGH', 'CRITICAL')
      `,
      ),
  },
  {
    id: 'criticalGuardCases',
    label: 'Guard cases at high risk',
    permission: 'guard:read',
    severity: 'critical',
    href: '/trust-safety/safeguarding?level=HIGH',
    count: database =>
      oldestAndCount(
        database,
        Prisma.sql`
        SELECT COUNT(*)::int AS count, MIN(g."created_at") AS oldest
        FROM "guard_threads" g
        WHERE g."state" IN ('OPEN', 'IN_PROGRESS')
          AND g."risk_level" IN ('HIGH', 'CRITICAL')
      `,
      ),
  },
  {
    id: 'pendingAnonymousPosts',
    label: 'Anonymous posts awaiting approval',
    permission: 'moderation:read',
    severity: 'high',
    href: '/trust-safety/queue?tab=anonymous',
    count: database =>
      oldestAndCount(
        database,
        Prisma.sql`
        SELECT COUNT(*)::int AS count, MIN(q."created_at") AS oldest
        FROM "moderation_queue_items" q
        WHERE q."type" = 'ANONYMOUS_POST' AND q."state" IN ('PENDING', 'IN_REVIEW')
      `,
      ),
  },
  {
    id: 'heldFlaggedContent',
    label: 'Flagged content held',
    permission: 'moderation:read',
    severity: 'high',
    href: '/trust-safety/queue?tab=flagged&tier=HIGH',
    count: database =>
      oldestAndCount(
        database,
        Prisma.sql`
        SELECT COUNT(*)::int AS count, MIN(q."created_at") AS oldest
        FROM "moderation_queue_items" q
        WHERE q."type" = 'GUARD_RISK' AND q."state" IN ('PENDING', 'IN_REVIEW')
          AND q."risk_level" IN ('HIGH', 'CRITICAL')
      `,
      ),
  },
  {
    id: 'openEscalations',
    label: 'Escalations to answer',
    permission: 'moderation:decide',
    severity: 'high',
    href: '/support/escalations',
    count: database =>
      oldestAndCount(
        database,
        // OPEN **and** ACKNOWLEDGED (§5.10). An acknowledged escalation is somebody saying "I
        // have this", which is not the same as an answer — dropping it off the count here would
        // make the dashboard say the work is done at the moment it is picked up.
        Prisma.sql`
        SELECT COUNT(*)::int AS count, MIN(e."created_at") AS oldest
        FROM "escalations" e
        WHERE e."state" IN ('OPEN', 'ACKNOWLEDGED')
      `,
      ),
  },
  {
    id: 'unassignedSupportThreads',
    label: 'Support threads nobody has',
    permission: 'support:read',
    severity: 'high',
    href: '/support/inbox?view=unassigned',
    count: database =>
      oldestAndCount(
        database,
        // `WAITING_ON_MEMBER` is out: we have answered those, and an unassigned thread we are not
        // waiting on is not work sitting still. `NEW` and `OPEN` are somebody's to pick up.
        //
        // `GUARD` is out as well, and that is the load-bearing line here. This item opens on
        // `support:read`, which Support hold and `guard:read` is deliberately not — so a count
        // including disclosures would tell them exactly how many exist, which is most of what R7
        // is protecting. Guard work has its own attention item on `guard:read` above.
        Prisma.sql`
        SELECT COUNT(*)::int AS count, MIN(t."created_at") AS oldest
        FROM "support_threads" t
        WHERE t."assigned_to_id" IS NULL
          AND t."state" IN ('NEW', 'OPEN')
          AND t."type" <> 'GUARD'
      `,
      ),
  },
  {
    id: 'openDisputes',
    label: 'Open disputes',
    permission: 'disputes:manage',
    severity: 'high',
    href: '/support/disputes',
    count: database =>
      oldestAndCount(
        database,
        Prisma.sql`
        SELECT COUNT(*)::int AS count, MIN(d."created_at") AS oldest
        FROM "disputes" d
        WHERE d."state" IN ('OPEN', 'IN_REVIEW')
      `,
      ),
  },
  {
    id: 'limitedReachContent',
    label: 'Content at medium risk',
    permission: 'moderation:read',
    severity: 'normal',
    href: '/trust-safety/queue?tab=flagged&tier=MEDIUM',
    count: database =>
      oldestAndCount(
        database,
        Prisma.sql`
        SELECT COUNT(*)::int AS count, MIN(q."created_at") AS oldest
        FROM "moderation_queue_items" q
        WHERE q."type" = 'GUARD_RISK' AND q."state" IN ('PENDING', 'IN_REVIEW')
          AND q."risk_level" = 'MEDIUM'
      `,
      ),
  },
  {
    id: 'dealProblems',
    label: 'Deals with a problem',
    permission: 'disputes:manage',
    severity: 'normal',
    href: '/support/disputes?tab=deals',
    count: database =>
      oldestAndCount(
        database,
        Prisma.sql`
        SELECT COUNT(*)::int AS count, MIN(d."problem_at") AS oldest
        FROM "deals" d
        WHERE d."has_problem" = true AND d."is_cancelled" = false
      `,
      ),
  },
  {
    id: 'openManagedRequests',
    label: 'Managed requests open',
    permission: 'support:read',
    severity: 'normal',
    href: '/support/managed?tab=briefs',
    count: database =>
      oldestAndCount(
        database,
        Prisma.sql`
        SELECT COUNT(*)::int AS count, MIN(r."created_at") AS oldest
        FROM "managed_requests" r
        WHERE r."state" IN ('OPEN', 'IN_PROGRESS')
      `,
      ),
  },
  {
    id: 'pendingAutoGuides',
    label: 'Drafted guides to review',
    permission: 'guides:publish',
    severity: 'normal',
    href: '/trust-safety/queue?tab=guides',
    count: database =>
      oldestAndCount(
        database,
        Prisma.sql`
        SELECT COUNT(*)::int AS count, MIN(q."created_at") AS oldest
        FROM "moderation_queue_items" q
        WHERE q."type" = 'AUTO_GUIDE' AND q."state" IN ('PENDING', 'IN_REVIEW')
      `,
      ),
  },
];

/**
 * The ids whose tables arrive with their own sections.
 *
 * Named here rather than silently absent so that the omission is a decision somebody wrote down:
 * `overdueModeration` needs report cases and their SLA clock (§4.6). Each joins the list with its
 * section and the contract does not change when it does — `openEscalations` did exactly that when
 * §5.10's escalations landed, and `unassignedSupportThreads` when §5.15's inbox did.
 */
export const ATTENTION_PENDING_SECTIONS = ['overdueModeration'] as const;

const SEVERITY_ORDER: Record<AttentionItem['severity'], number> = {
  critical: 0,
  high: 1,
  normal: 2,
};

const oldestAndCount = async (
  database: PrismaService,
  sql: Prisma.Sql,
): Promise<{ count: number; oldestAt: Date | null }> => {
  const [row] = await database.$queryRaw<Array<{ count: number; oldest: Date | null }>>(sql);

  return { count: Number(row?.count ?? 0), oldestAt: row?.oldest ?? null };
};

/**
 * The page the portal opens on (§5.24).
 *
 * Every widget is filtered by permission rather than by role, and an absent widget is **omitted**
 * rather than nulled — a card showing a dash is a staff member wondering whether the number is zero
 * or whether they are not allowed to see it.
 */
@Injectable()
export class AdminDashboardService {
  constructor(
    private readonly database: PrismaService,
    private readonly filters: MemberFilterBuilder,
    private readonly runner: AnalyticsRunnerService,
    private readonly overview: OverviewAnalytics,
    private readonly media: MediaService,
  ) {}

  /** The KPI cards this caller may see. */
  async kpis(actor: AdminPrincipal, dto: DashboardFilterDto) {
    const filter = await this.filters.resolve(dto);
    const range = filter.range!;
    const cards: Record<string, Chart> = {};
    const narrowed = await this.narrowPopulation(dto, filter);

    if (actor.permissions.has('analytics:read')) {
      const { charts } = await this.runner.charts(
        this.runner.keyFor('dashboard:kpis', { ...dto }, 'analytics'),
        { kpis: () => this.overview.charts(filter, range).kpis() },
        { includesToday: this.runner.includesToday(range.to) },
      );

      const group = charts.kpis;

      if (group.kind === 'group') {
        // §2.7's population floor, which this screen did not have: a city filter selecting four
        // members showed their figures, and nothing in the response said so. Applied to the
        // **filtered** cards only — see below.
        Object.assign(cards, narrowed ? suppressEverything(group.items) : group.items);
      }

      cards.openRequests = await this.openRequests();
    }

    // The three operational counts, each behind its own permission. A KPI row is the first thing
    // anybody looks at, so the shape of it has to say what this person is responsible for.
    if (actor.permissions.has('reports:read')) cards.openReports = await this.openReports();
    if (actor.permissions.has('guard:read')) cards.openGuardCases = await this.openGuardCases();

    // Deliberately **not** suppressed, and this is the distinction the floor turns on: these three
    // are platform-wide counts of work — open requests, open reports, open Guard cases — and no
    // filter reaches them. Blanking "41 open reports" because somebody had a city selected would
    // withhold a number that is not about those members at all, and would read as a bug rather
    // than as a privacy rule.
    return {
      cards,
      ...(narrowed ? { meta: { populationSuppressed: true as const } } : {}),
    };
  }

  /** What needs somebody now, worst first. */
  async attention(actor: AdminPrincipal): Promise<AttentionItem[]> {
    const allowed = ATTENTION.filter(entry => actor.permissions.has(entry.permission));
    const rows = await Promise.all(
      allowed.map(async entry => ({ entry, ...(await entry.count(this.database)) })),
    );

    return (
      rows
        // Zero is omitted, not shown: a list of twelve zeroes is a list nobody reads, and the whole
        // point of this panel is that anything on it needs doing.
        .filter(row => row.count > 0)
        .map(row => ({
          id: row.entry.id,
          label: row.entry.label,
          count: row.count,
          oldestAt: row.oldestAt?.toISOString() ?? null,
          severity: row.entry.severity,
          href: row.entry.href,
        }))
        .sort(
          (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.count - a.count,
        )
    );
  }

  /** The four charts, which are the Overview tab's — one computation, one cache entry. */
  async charts(dto: DashboardFilterDto) {
    const filter = await this.filters.resolve(dto);
    const range = filter.range!;
    const all = this.overview.charts(filter, range);
    const narrowed = await this.narrowPopulation(dto, filter);

    const { charts, cache } = await this.runner.charts(
      this.runner.keyFor('dashboard:charts', { ...dto }, 'analytics'),
      {
        signups: all.signups,
        activeMembers: all.activeMembers,
        activityBySection: all.activityBySection,
        topCities: all.topCities,
      },
      { includesToday: this.runner.includesToday(range.to) },
    );

    return {
      // Every chart here is filtered, so all four go when the population is narrow — unlike the
      // KPI row, which carries three unfiltered operational counts beside the filtered ones.
      data: narrowed ? suppressEverything(charts) : charts,
      meta: {
        range: {
          from: range.from,
          to: range.to,
          granularity: range.granularity,
          timezone: range.timezone,
        },
        cache,
        ...(narrowed ? { populationSuppressed: true as const } : {}),
      },
    };
  }

  /**
   * Whether the filters select fewer than ten members (§2.7).
   *
   * The same floor the analytics tabs apply, through the same counter — the dashboard reached none
   * of it, which made the one screen everybody opens the one screen without the rule. Counted only
   * when a member-attribute filter is actually in force, so an unfiltered dashboard costs nothing.
   */
  private async narrowPopulation(
    dto: DashboardFilterDto,
    filter: ResolvedMemberFilter,
  ): Promise<boolean> {
    if (!dto.cityIds?.length) return false;

    const population = await this.runner.populationSize(filter.viewSql);

    return population > 0 && population < POPULATION_FLOOR;
  }

  /** The last twenty things staff did, within the caller's audit scope (R8). */
  async staffActivity(actor: AdminPrincipal): Promise<AuditEntryView[]> {
    const scope = auditScopeFor(actor);

    if (!scope) return [];

    const rows = await this.database.auditLog.findMany({
      where: scope,
      orderBy: { occurredAt: 'desc' },
      take: 20,
    });

    const staff = await this.database.user.findMany({
      where: { id: { in: [...new Set(rows.map(row => row.actorId).filter(Boolean))] as string[] } },
      select: staffRefSelect,
    });

    const sign = (key: string) => this.media.sign(key);
    const byId = new Map(staff.map(row => [row.id, toStaffRef(row, sign)]));

    return rows.map(row => toAuditEntry(row, row.actorId ? (byId.get(row.actorId) ?? null) : null));
  }

  private async openRequests(): Promise<Chart> {
    const value = await this.database.communityRequest.count({
      where: { status: 'OPEN', deletedAt: null },
    });

    return { kind: 'kpi', value, previous: null, changePct: null, unit: 'count', sparkline: [] };
  }

  private async openReports(): Promise<Chart> {
    const value = await this.database.report.count({
      where: { state: { in: ['RECEIVED', 'TRIAGED'] } },
    });

    return { kind: 'kpi', value, previous: null, changePct: null, unit: 'count', sparkline: [] };
  }

  private async openGuardCases(): Promise<Chart> {
    const value = await this.database.guardThread.count({
      where: { state: { in: ['OPEN', 'IN_PROGRESS'] } },
    });

    return { kind: 'kpi', value, previous: null, changePct: null, unit: 'count', sparkline: [] };
  }
}
