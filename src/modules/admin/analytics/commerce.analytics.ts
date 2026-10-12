import { Injectable } from '@nestjs/common';
import { Prisma, StoreComplianceState, StoreStatus, TaxonomyKind } from '@prisma/client';
import { TaxonomyService } from '@/modules/platform/shared';
import { AnalyticsRunnerService } from './analytics-runner.service';
import {
  BreakdownChart,
  Chart,
  FunnelChart,
  MatrixChart,
  Num,
  Point,
  TableChart,
  TimeSeriesChart,
} from './chart.types';
import { Bucket, bucketsFor, indexByDay } from './buckets';
import { toBreakdown, toMatrix } from './breakdown';
import { ResolvedMemberFilter, ResolvedRange } from '../filters/member-filter.builder';
import { CommerceFilters } from '../dtos/admin-analytics.dto';

/** The stages an enquiry passes through, as the funnel reads them. */
const ENQUIRY_FUNNEL = [
  { key: 'placed', label: 'Placed' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'ready', label: 'Ready' },
  { key: 'received', label: 'Received' },
] as const;

/**
 * Commerce (§5.25).
 *
 * Shops, what they stock and what people ask for. Counts of shops and items are counts of
 * **things**, so the member floor does not apply to them — a town with three shops is not a
 * disclosure about three people, it is a fact about the town that staff need in order to decide
 * where to recruit sellers. The member filter still narrows by the shop's **owner**.
 */
@Injectable()
export class CommerceAnalytics {
  constructor(
    private readonly runner: AnalyticsRunnerService,
    private readonly taxonomy: TaxonomyService,
  ) {}

  static readonly FILTER_SEMANTICS: Record<string, string> = {
    cityIds: "the shop's own city, not the owner's",
  };

  charts(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: CommerceFilters,
  ): Record<string, () => Promise<Chart>> {
    return {
      storesByType: () => this.storesByType(filter, extra),
      storesByCity: () => this.storesByCity(filter, extra),
      itemsByCategory: () => this.itemsByCategory(filter, extra),
      enquiries: () => this.enquiries(filter, range, extra),
      enquiryFunnel: () => this.enquiryFunnel(filter, range, extra),
      enquiryOutcomes: () => this.enquiryOutcomes(filter, range, extra),
      storeStatusCompliance: () => this.storeStatusCompliance(filter, extra),
      topStores: () => this.topStores(filter, range, extra),
    };
  }

  /**
   * The shops, as a CTE: owned by somebody in the population and matching the tab's own filters.
   *
   * Not bounded by the date range. A shop is a standing thing rather than an event, so "shops by
   * type" means the shops that exist — and restricting it to shops opened inside the range would
   * answer a question nobody asked while looking like the one they did.
   */
  private shops(filter: ResolvedMemberFilter, extra: CommerceFilters): Prisma.Sql {
    const parts: Prisma.Sql[] = [];

    if (extra.cityIds?.length) {
      parts.push(Prisma.sql`s."city_id" IN (${Prisma.join(extra.cityIds)})`);
    }

    if (extra.storeTypes?.length) {
      parts.push(Prisma.sql`s."type_code" IN (${Prisma.join(extra.storeTypes)})`);
    }

    if (extra.storeStatus?.length) {
      parts.push(Prisma.sql`s."status"::text IN (${Prisma.join(extra.storeStatus)})`);
    }

    if (extra.complianceState?.length) {
      parts.push(Prisma.sql`s."compliance_state"::text IN (${Prisma.join(extra.complianceState)})`);
    }

    return Prisma.sql`
      pop AS (
        SELECT m."user_id" FROM "mv_member_dimensions" m WHERE ${filter.viewSql}
      ),
      shops AS (
        SELECT s."id", s."name", s."type_code", s."city_id", s."status"::text AS status,
               s."compliance_state"::text AS compliance_state, s."owner_id"
        FROM "stores" s
        JOIN pop ON pop."user_id" = s."owner_id"
        WHERE s."deleted_at" IS NULL${parts.length ? Prisma.sql` AND ${Prisma.join(parts, ' AND ')}` : Prisma.empty}
      )`;
  }

  private fulfilment(extra: CommerceFilters): Prisma.Sql {
    return extra.fulfilment?.length
      ? Prisma.sql`AND e."fulfilment"::text IN (${Prisma.join(extra.fulfilment)})`
      : Prisma.empty;
  }

  private async storesByType(
    filter: ResolvedMemberFilter,
    extra: CommerceFilters,
  ): Promise<BreakdownChart> {
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ key: string | null; total: bigint }>>`
        WITH ${this.shops(filter, extra)}
        SELECT "type_code" AS key, COUNT(*) AS total FROM shops GROUP BY 1
      `,
    );

    return toBreakdown(rows, {
      unit: 'count',
      labels: await this.taxonomy.labels(TaxonomyKind.STORE_TYPE),
    });
  }

  private async storesByCity(
    filter: ResolvedMemberFilter,
    extra: CommerceFilters,
  ): Promise<BreakdownChart> {
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ key: string | null; label: string | null; total: bigint }>>`
        WITH ${this.shops(filter, extra)}
        SELECT shops."city_id" AS key, c."name" AS label, COUNT(*) AS total
        FROM shops
        LEFT JOIN "cities" c ON c."id" = shops."city_id"
        GROUP BY 1, 2
      `,
    );

    return toBreakdown(rows, {
      unit: 'count',
      top: 15,
      labels: new Map(rows.filter(row => row.key).map(row => [row.key!, row.label ?? row.key!])),
    });
  }

  /**
   * What is on the shelves — excluding drafts, which are nobody's stock but the owner's.
   *
   * A draft is half-written or withdrawn and is returned to its owner and to nobody else, so
   * counting it would describe a catalogue no member can see.
   */
  private async itemsByCategory(
    filter: ResolvedMemberFilter,
    extra: CommerceFilters,
  ): Promise<BreakdownChart> {
    const categories = extra.itemCategories?.length
      ? Prisma.sql`AND i."category_code" IN (${Prisma.join(extra.itemCategories)})`
      : Prisma.empty;

    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ key: string | null; total: bigint }>>`
        WITH ${this.shops(filter, extra)}
        SELECT i."category_code" AS key, COUNT(*) AS total
        FROM "store_items" i
        JOIN shops ON shops."id" = i."store_id"
        WHERE i."deleted_at" IS NULL AND i."availability" <> 'DRAFT' ${categories}
        GROUP BY 1
      `,
    );

    return toBreakdown(rows, {
      unit: 'count',
      labels: await this.taxonomy.labels(TaxonomyKind.ITEM_CATEGORY),
    });
  }

  private async enquiries(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: CommerceFilters,
  ): Promise<TimeSeriesChart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ day: Date; total: bigint }>>`
        WITH ${this.shops(filter, extra)}
        SELECT (e."created_at" AT TIME ZONE 'Europe/London')::date AS day, COUNT(*) AS total
        FROM "enquiries" e
        JOIN shops ON shops."id" = e."store_id"
        WHERE e."created_at" >= ${range.fromInstant} AND e."created_at" < ${range.toInstant}
          ${this.fulfilment(extra)}
        GROUP BY 1
      `,
    );

    return {
      kind: 'timeseries',
      granularity: range.granularity,
      unit: 'count',
      series: [{ key: 'enquiries', label: 'Enquiries', points: layOn(buckets, rows) }],
    };
  }

  /**
   * Placed, accepted, ready, received — each step meaning "got **at least** this far".
   *
   * The product's own flow, which is worth stating because the names are easy to misread: an
   * enquiry is *created* in state `ACCEPTED`, which the buyer sees as "Placed"; the seller
   * confirming it writes the `ACCEPTED` event and moves it to `IN_PROGRESS`; delivering sets
   * `ready_at`; the buyer completing sets `received_at`.
   *
   * So the four steps come from three kinds of evidence — the state, an event and two columns — and
   * each counts an enquiry that **reached or passed** it, from whichever of the three says so. The
   * state leads, because that is the fact `enquiryOutcomes` reads: without it the two charts
   * disagreed on one page, the outcome saying an enquiry had completed while the funnel said it was
   * never received, because the row carried `completed_at` and no `received_at`. The timestamps and
   * events are bookkeeping and can be absent; the state cannot.
   *
   * Reading it this way buys two properties that hold whatever the data looks like: the funnel is
   * monotonic by construction, so a later step can never exceed an earlier one, and its last step
   * agrees with the outcomes breakdown beside it.
   */
  private async enquiryFunnel(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: CommerceFilters,
  ): Promise<FunnelChart> {
    const [row] = await this.runner.query(
      tx => tx.$queryRaw<
        Array<{ placed: bigint; accepted: bigint; ready: bigint; received: bigint }>
      >`
        WITH ${this.shops(filter, extra)}
        SELECT COUNT(*) AS placed,
               COUNT(CASE WHEN
                 e."state"::text IN ('IN_PROGRESS', 'DELIVERED', 'CHANGES_REQUESTED', 'COMPLETED')
                 OR e."received_at" IS NOT NULL
                 OR e."ready_at" IS NOT NULL
                 OR EXISTS (
                   SELECT 1 FROM "enquiry_events" ev
                   WHERE ev."enquiry_id" = e."id"
                     AND ev."stage" IN ('ACCEPTED', 'DELIVERED', 'DONE', 'REVIEWED')
                 )
               THEN 1 END) AS accepted,
               COUNT(CASE WHEN
                 e."state"::text IN ('DELIVERED', 'COMPLETED')
                 OR e."ready_at" IS NOT NULL
                 OR e."received_at" IS NOT NULL
               THEN 1 END) AS ready,
               COUNT(CASE WHEN e."state"::text = 'COMPLETED' OR e."received_at" IS NOT NULL
                 THEN 1 END) AS received
        FROM "enquiries" e
        JOIN shops ON shops."id" = e."store_id"
        WHERE e."created_at" >= ${range.fromInstant} AND e."created_at" < ${range.toInstant}
          ${this.fulfilment(extra)}
      `,
    );

    const values = [
      Number(row?.placed ?? 0),
      Number(row?.accepted ?? 0),
      Number(row?.ready ?? 0),
      Number(row?.received ?? 0),
    ];
    const start = values[0];

    return {
      kind: 'funnel',
      // Enquiries, not members — the member floor would put holes in a small shop's funnel.
      unit: 'count',
      steps: ENQUIRY_FUNNEL.map((step, index) => ({
        key: step.key,
        label: step.label,
        value: values[index],
        fromPrevious: index === 0 ? 1 : ratio(values[index], values[index - 1]),
        fromStart: ratio(values[index], start),
      })),
    };
  }

  /**
   * How enquiries ended, with `DECLINED` separated from `CANCELLED`.
   *
   * Both are `CANCELLED` in the data; the difference is who did it. A seller turning work away and
   * a buyer changing their mind are opposite facts about a shop, and merging them would hide the one
   * staff would act on.
   */
  private async enquiryOutcomes(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: CommerceFilters,
  ): Promise<BreakdownChart> {
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ key: string | null; total: bigint }>>`
        WITH ${this.shops(filter, extra)}
        SELECT CASE
                 WHEN e."state" = 'COMPLETED' THEN 'COMPLETED'
                 WHEN e."state" = 'CANCELLED' AND EXISTS (
                   SELECT 1 FROM "enquiry_events" ev
                   WHERE ev."enquiry_id" = e."id" AND ev."stage" = 'CANCELLED'
                     AND ev."actor_id" = e."seller_id"
                 ) THEN 'DECLINED'
                 WHEN e."state" = 'CANCELLED' THEN 'CANCELLED'
                 WHEN e."expires_at" IS NOT NULL AND e."expires_at" < now()
                   AND e."state" NOT IN ('COMPLETED', 'CANCELLED') THEN 'EXPIRED'
               END AS key,
               COUNT(*) AS total
        FROM "enquiries" e
        JOIN shops ON shops."id" = e."store_id"
        WHERE e."created_at" >= ${range.fromInstant} AND e."created_at" < ${range.toInstant}
          ${this.fulfilment(extra)}
        GROUP BY 1
      `,
    );

    // An enquiry still in progress has no outcome yet and is left out: counting it as a failure
    // would make every chart of a recent range look like one.
    return toBreakdown(
      rows.filter(row => row.key !== null),
      {
        unit: 'count',
        order: ['COMPLETED', 'DECLINED', 'CANCELLED', 'EXPIRED'],
        labels: new Map([
          ['COMPLETED', 'Completed'],
          ['DECLINED', 'Declined by the shop'],
          ['CANCELLED', 'Cancelled by the buyer'],
          ['EXPIRED', 'Expired'],
        ]),
      },
    );
  }

  /** Status against compliance — the cross that finds a shop open while under review. */
  private async storeStatusCompliance(
    filter: ResolvedMemberFilter,
    extra: CommerceFilters,
  ): Promise<MatrixChart> {
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ row: string | null; col: string | null; total: bigint }>>`
        WITH ${this.shops(filter, extra)}
        SELECT "status" AS row, "compliance_state" AS col, COUNT(*) AS total
        FROM shops GROUP BY 1, 2
      `,
    );

    return toMatrix(rows, {
      unit: 'count',
      rows: Object.values(StoreStatus).map(status => ({ key: status, label: titleise(status) })),
      cols: Object.values(StoreComplianceState).map(state => ({
        key: state,
        label: titleise(state),
      })),
    });
  }

  /** The twenty busiest shops in the range, by enquiries taken. */
  private async topStores(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: CommerceFilters,
  ): Promise<TableChart> {
    const rows = await this.runner.query(
      tx => tx.$queryRaw<
        Array<{
          store_id: string;
          name: string;
          city: string | null;
          enquiries: bigint;
          completed: bigint;
          views: bigint;
        }>
      >`
        WITH ${this.shops(filter, extra)}
        SELECT shops."id" AS store_id, shops."name" AS name, c."name" AS city,
               COUNT(e."id") AS enquiries,
               COUNT(CASE WHEN e."state" = 'COMPLETED' THEN 1 END) AS completed,
               (
                 SELECT COUNT(*) FROM "activity_events" ae
                 WHERE ae."verb" = 'VIEW' AND ae."subject" = 'STORE'
                   AND ae."subject_id" = shops."id"
                   AND ae."occurred_at" >= ${range.fromInstant}
                   AND ae."occurred_at" < ${range.toInstant}
               ) AS views
        FROM shops
        LEFT JOIN "cities" c ON c."id" = shops."city_id"
        LEFT JOIN "enquiries" e ON e."store_id" = shops."id"
          AND e."created_at" >= ${range.fromInstant} AND e."created_at" < ${range.toInstant}
        GROUP BY 1, 2, 3
        ORDER BY enquiries DESC, views DESC
        LIMIT 20
      `,
    );

    return {
      kind: 'table',
      columns: [
        { key: 'storeId', label: 'Shop' },
        { key: 'name', label: 'Name' },
        { key: 'city', label: 'City' },
        { key: 'enquiries', label: 'Enquiries', unit: 'count' },
        { key: 'completed', label: 'Completed', unit: 'count' },
        { key: 'views', label: 'Views', unit: 'count' },
      ],
      rows: rows.map(row => ({
        storeId: row.store_id,
        name: row.name,
        city: row.city,
        enquiries: Number(row.enquiries),
        completed: Number(row.completed),
        views: Number(row.views),
      })),
    };
  }
}

const ratio = (value: number, base: number): Num =>
  base > 0 ? Math.round((value / base) * 1000) / 1000 : null;

const titleise = (code: string): string =>
  code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, ' ');

const dayKey = (day: Date): string => day.toISOString().slice(0, 10);

const layOn = (buckets: Bucket[], rows: Array<{ day: Date; total: bigint }>): Point[] => {
  const index = indexByDay(buckets);
  const totals = buckets.map(() => 0);

  for (const row of rows) {
    const position = index.get(dayKey(row.day));

    if (position !== undefined) totals[position] += Number(row.total);
  }

  return buckets.map((bucket, position) => ({ t: bucket.key, v: totals[position] }));
};
