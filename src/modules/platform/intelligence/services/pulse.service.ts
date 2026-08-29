import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/infrastructure';
import { MetricItem, MetricPeriod, MetricSection } from './metrics.service';

export type PulseScope = 'community' | 'professionals' | 'connect' | 'commerce';

const SECTIONS: Record<PulseScope, MetricSection> = {
  community: 'COMMUNITY',
  professionals: 'PROFESSIONALS',
  connect: 'CONNECT',
  commerce: 'COMMERCE',
};

/** The suppression floor, per scope (6.2.1). */
export const PULSE_FLOORS: Record<PulseScope, number> = {
  community: 5,
  professionals: 5,
  commerce: 5,
  connect: 20,
};

/** How each dashboard is assembled from the snapshots the engine already writes. */
interface ScopeShape {
  /** Up to three headline numbers, in order. */
  stats: Array<{ metric: string; label: string; aggregate: 'sum' | 'first' | 'count' }>;
  barsTitle: string;
  barsMetric: string;
  actionsTitle: string;
  actionsMetric: string;
  action: (item: MetricItem) => { label: string; detail: string; actionLabel: string; route: string };
}

const SHAPES: Record<PulseScope, ScopeShape> = {
  community: {
    stats: [
      { metric: 'topRequests', label: 'Requests this period', aggregate: 'sum' },
      { metric: 'unansweredRequests', label: 'Still unanswered', aggregate: 'sum' },
      { metric: 'activeGroups', label: 'Active groups', aggregate: 'count' },
    ],
    barsTitle: 'What people asked about',
    barsMetric: 'topRequests',
    actionsTitle: 'Where you could help',
    actionsMetric: 'unansweredRequests',
    action: item => ({
      label: `${item.value} ${item.label.toLowerCase()} question${item.value === 1 ? '' : 's'} unanswered`,
      detail: 'Nobody has replied to these yet',
      actionLabel: 'Take a look',
      route: `/community?category=${item.code ?? ''}`,
    }),
  },
  professionals: {
    stats: [
      { metric: 'jobsThisPeriod', label: 'Jobs this period', aggregate: 'sum' },
      { metric: 'servicesInDemand', label: 'Services in demand', aggregate: 'count' },
      { metric: 'averageResponseMinutes', label: 'Average reply time', aggregate: 'first' },
    ],
    barsTitle: 'What people are looking for',
    barsMetric: 'servicesInDemand',
    actionsTitle: 'Where you could help',
    actionsMetric: 'servicesInDemand',
    action: item => ({
      label: `${item.value} people looking for ${item.label.toLowerCase()}`,
      detail: 'Listing this service puts you in front of them',
      actionLabel: 'See the demand',
      route: `/professionals?category=${item.code ?? ''}`,
    }),
  },
  commerce: {
    stats: [
      { metric: 'topProducts', label: 'Products listed', aggregate: 'count' },
      { metric: 'storesByCategory', label: 'Shops trading', aggregate: 'sum' },
      { metric: 'mostSearched', label: 'Searches this period', aggregate: 'sum' },
    ],
    barsTitle: 'What people searched for',
    barsMetric: 'mostSearched',
    actionsTitle: 'What is selling',
    actionsMetric: 'topProducts',
    action: item => ({
      label: `${item.label}`,
      detail: `${item.value} people looked at this`,
      actionLabel: 'Browse',
      route: `/commerce?category=${item.code ?? ''}`,
    }),
  },
  connect: {
    stats: [{ metric: 'trendingTypes', label: 'People connecting', aggregate: 'sum' }],
    barsTitle: 'What people are looking for',
    barsMetric: 'trendingTypes',
    actionsTitle: 'Where you could help',
    actionsMetric: 'trendingTypes',
    action: item => ({
      label: `${item.value} people looking for ${item.label.toLowerCase()}`,
      detail: 'Your profile is shown to people looking for this',
      actionLabel: 'See who',
      route: `/connect?type=${item.code ?? ''}`,
    }),
  },
};

/** Pulse: four read-only dashboards, aggregate only (6.2). */
@Injectable()
export class PulseService {
  constructor(private readonly database: PrismaService) {}

  async dashboard(scope: PulseScope, cityId: string | null, period: MetricPeriod = 'MONTH') {
    const section = SECTIONS[scope];
    const shape = SHAPES[scope];
    const floor = PULSE_FLOORS[scope];

    const snapshots = await this.database.metricSnapshot.findMany({
      where: { section, cityId: cityId ?? '', period },
    });

    const byMetric = new Map(
      snapshots.map(row => [row.metric, (row.items as unknown as MetricItem[]) ?? []]),
    );

    const contributingMembers = byMetric.get('contributingMembers')?.[0]?.value ?? 0;
    const updatedAt = snapshots[0]?.windowEnd?.toISOString() ?? null;

    // Below the floor the shape still comes back, with empty arrays.
    if (contributingMembers < floor) {
      return {
        data: {
          stats: [],
          barsTitle: shape.barsTitle,
          bars: [],
          actionsTitle: shape.actionsTitle,
          actions: [],
          contributingMembers,
          updatedAt,
        },
      };
    }

    const bars = byMetric.get(shape.barsMetric) ?? [];
    // Sent rather than derived, so the chart is not rescaled by whichever slice happens to be largest in the returned page (6.2).
    const max = bars.reduce((highest, item) => Math.max(highest, item.value), 0);

    return {
      data: {
        stats: shape.stats
          .map(stat => this.stat(stat, byMetric.get(stat.metric) ?? []))
          .filter(Boolean),
        barsTitle: shape.barsTitle,
        bars: bars.slice(0, 6).map(item => ({ label: item.label, value: item.value, max })),
        actionsTitle: shape.actionsTitle,
        actions: (byMetric.get(shape.actionsMetric) ?? [])
          // If a count would be 1, suppress the row rather than sending it (D34).
          .filter(item => item.value > 1)
          .slice(0, 3)
          .map(shape.action),
        contributingMembers,
        updatedAt,
      },
    };
  }

  /** `value` is a string, deliberately. */
  private stat(
    stat: { metric: string; label: string; aggregate: 'sum' | 'first' | 'count' },
    items: MetricItem[],
  ) {
    if (!items.length) return null;

    const raw =
      stat.aggregate === 'sum'
        ? items.reduce((total, item) => total + item.value, 0)
        : stat.aggregate === 'count'
          ? items.length
          : items[0].value;

    return {
      label: stat.label,
      value: compact(raw),
      // Null when there is no prior period to compare.
      deltaLabel: null,
      isUp: null,
    };
  }
}

/** "34", "2.4k", "1.2m". Already formatted, and never compared by the client. */
const compact = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`;

  return String(value);
};
