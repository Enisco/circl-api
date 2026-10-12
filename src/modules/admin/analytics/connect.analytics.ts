import { Injectable } from '@nestjs/common';
import { Gender, Prisma, TaxonomyKind } from '@prisma/client';
import { birthDateRangeForAges, londonMidnight, shiftDateOnly } from '@/common';
import { TaxonomyService } from '@/modules/platform/shared';
import { AnalyticsRunnerService } from './analytics-runner.service';
import { BreakdownChart, Chart, MatrixChart, Point, TimeSeriesChart } from './chart.types';
import { Bucket, bucketsFor, indexByDay } from './buckets';
import { toBreakdown, toMatrix } from './breakdown';
import { ResolvedMemberFilter, ResolvedRange } from '../filters/member-filter.builder';
import { ConnectFilters } from '../dtos/admin-analytics.dto';

const GENDERS = [...Object.values(Gender), 'UNKNOWN'] as const;

/**
 * Connect (§5.25).
 *
 * The section with the sharpest privacy edge on this tab list: a Connect profile is somebody saying
 * what they are looking for, and `ageGender` crosses two attributes over a self-selected group. So
 * every count here is members and goes out through the floor — and the floor stays at ten even
 * though Pulse applies twenty to the member-facing version, because this surface is staff-only and
 * the §14 OQ2 answer says so.
 */
@Injectable()
export class ConnectAnalytics {
  constructor(
    private readonly runner: AnalyticsRunnerService,
    private readonly taxonomy: TaxonomyService,
  ) {}

  charts(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: ConnectFilters,
  ): Record<string, () => Promise<Chart>> {
    return {
      profilesByType: () => this.profilesByType(filter, range, extra),
      profilesCreated: () => this.profilesCreated(filter, range, extra),
      connectionRequests: () => this.connectionRequests(filter, range, extra),
      acceptanceRate: () => this.acceptanceRate(filter, range, extra),
      storiesPerDay: () => this.storiesPerDay(filter, range, extra),
      ageGender: () => this.ageGender(filter, range, extra),
      dmPolicy: () => this.dmPolicyMix(filter, range, extra),
    };
  }

  /**
   * The population, joined to their Connect profile.
   *
   * Every chart on this tab is about profile owners, so the join is in the CTE rather than repeated
   * — and it is an inner join, which is what makes "members" here mean "members who are on Connect"
   * rather than the whole platform.
   */
  private pop(filter: ResolvedMemberFilter, extra: ConnectFilters): Prisma.Sql {
    const parts: Prisma.Sql[] = [];

    if (extra.connectionTypes?.length) {
      parts.push(Prisma.sql`cp."type_code" IN (${Prisma.join(extra.connectionTypes)})`);
    }

    if (extra.dmPolicy?.length) {
      parts.push(Prisma.sql`cp."dm_policy"::text IN (${Prisma.join(extra.dmPolicy)})`);
    }

    if (extra.isVisible !== undefined) {
      parts.push(Prisma.sql`cp."is_visible" = ${extra.isVisible}`);
    }

    return Prisma.sql`
      pop AS (
        SELECT m."user_id", m."gender", m."date_of_birth",
               cp."id" AS profile_id, cp."type_code", cp."dm_policy"::text AS dm_policy,
               cp."created_at"
        FROM "mv_member_dimensions" m
        JOIN "connect_profiles" cp ON cp."user_id" = m."user_id"
        WHERE ${filter.viewSql}${parts.length ? Prisma.sql` AND ${Prisma.join(parts, ' AND ')}` : Prisma.empty}
      )`;
  }

  private async profilesByType(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: ConnectFilters,
  ): Promise<BreakdownChart> {
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ key: string | null; total: bigint }>>`
        WITH ${this.pop(filter, extra)}
        SELECT pop."type_code" AS key, COUNT(*) AS total
        FROM pop
        WHERE pop."created_at" < ${range.toInstant}
        GROUP BY 1
      `,
    );

    return toBreakdown(rows, { labels: await this.taxonomy.labels(TaxonomyKind.CONNECTION_TYPE) });
  }

  private async profilesCreated(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: ConnectFilters,
  ): Promise<TimeSeriesChart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ day: Date; total: bigint }>>`
        WITH ${this.pop(filter, extra)}
        SELECT (pop."created_at" AT TIME ZONE 'Europe/London')::date AS day, COUNT(*) AS total
        FROM pop
        WHERE pop."created_at" >= ${range.fromInstant} AND pop."created_at" < ${range.toInstant}
        GROUP BY 1
      `,
    );

    return {
      kind: 'timeseries',
      granularity: range.granularity,
      unit: 'members',
      series: [{ key: 'profilesCreated', label: 'Profiles created', points: layOn(buckets, rows) }],
    };
  }

  /**
   * Requests sent, and requests accepted.
   *
   * Counted by different dates on purpose: `sent` by when it was sent, `accepted` by when it was
   * **answered**. A request sent in March and accepted in April belongs to March on one line and
   * April on the other, because the question each answers is different — how much reaching out
   * happened, and how much of it landed.
   */
  private async connectionRequests(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: ConnectFilters,
  ): Promise<TimeSeriesChart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);
    const [sent, accepted] = await Promise.all([
      this.requestRows(filter, range, extra, 'sent'),
      this.requestRows(filter, range, extra, 'accepted'),
    ]);

    return {
      kind: 'timeseries',
      granularity: range.granularity,
      unit: 'count',
      series: [
        { key: 'sent', label: 'Requests sent', points: layOn(buckets, sent) },
        { key: 'accepted', label: 'Accepted', points: layOn(buckets, accepted) },
      ],
    };
  }

  private async requestRows(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: ConnectFilters,
    which: 'sent' | 'accepted' | 'responded',
  ): Promise<Array<{ day: Date; total: bigint }>> {
    const clause =
      which === 'sent'
        ? Prisma.sql`
            (cr."created_at" AT TIME ZONE 'Europe/London')::date AS day
            FROM "connection_requests" cr
            JOIN pop ON pop."user_id" = cr."from_user_id"
            WHERE cr."created_at" >= ${range.fromInstant} AND cr."created_at" < ${range.toInstant}`
        : which === 'accepted'
          ? Prisma.sql`
            (cr."responded_at" AT TIME ZONE 'Europe/London')::date AS day
            FROM "connection_requests" cr
            JOIN pop ON pop."user_id" = cr."from_user_id"
            WHERE cr."responded_at" >= ${range.fromInstant} AND cr."responded_at" < ${range.toInstant}
              AND cr."state" = 'ACCEPTED'`
          : Prisma.sql`
            (cr."responded_at" AT TIME ZONE 'Europe/London')::date AS day
            FROM "connection_requests" cr
            JOIN pop ON pop."user_id" = cr."from_user_id"
            WHERE cr."responded_at" >= ${range.fromInstant} AND cr."responded_at" < ${range.toInstant}
              AND cr."state" IN ('ACCEPTED', 'DECLINED')`;

    return this.runner.query(
      tx => tx.$queryRaw<Array<{ day: Date; total: bigint }>>`
        WITH ${this.pop(filter, extra)}
        SELECT ${clause}
        GROUP BY 1
      `,
    );
  }

  /**
   * Accepted over answered — on its own chart, never beside the counts.
   *
   * A ratio and a count cannot share an axis: at a hundred requests a week, a rate of 0.4 is a flat
   * line on the floor of the chart. The denominator is requests that were **answered**, not sent: a
   * request still pending is not a refusal, and counting it as one makes the rate fall every time
   * somebody is slow to reply.
   */
  private async acceptanceRate(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: ConnectFilters,
  ): Promise<TimeSeriesChart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);
    const [accepted, responded] = await Promise.all([
      this.requestRows(filter, range, extra, 'accepted'),
      this.requestRows(filter, range, extra, 'responded'),
    ]);

    const yes = layOn(buckets, accepted).map(point => point.v ?? 0);
    const answered = layOn(buckets, responded).map(point => point.v ?? 0);

    return {
      kind: 'timeseries',
      granularity: range.granularity,
      unit: 'ratio',
      series: [
        {
          key: 'acceptanceRate',
          label: 'Accepted',
          points: buckets.map((bucket, position) => ({
            t: bucket.key,
            // Null where nobody answered: a bucket with no replies has no acceptance rate, and a
            // zero would read as "everybody said no".
            v:
              answered[position] > 0
                ? Math.round((yes[position] / answered[position]) * 1000) / 1000
                : null,
          })),
        },
      ],
    };
  }

  private async storiesPerDay(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: ConnectFilters,
  ): Promise<TimeSeriesChart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ day: Date; total: bigint }>>`
        WITH ${this.pop(filter, extra)}
        SELECT (cs."posted_at" AT TIME ZONE 'Europe/London')::date AS day, COUNT(*) AS total
        FROM "connect_stories" cs
        JOIN pop ON pop."user_id" = cs."user_id"
        WHERE cs."posted_at" >= ${range.fromInstant} AND cs."posted_at" < ${range.toInstant}
        GROUP BY 1
      `,
    );

    return {
      kind: 'timeseries',
      granularity: range.granularity,
      unit: 'count',
      series: [{ key: 'storiesPerDay', label: 'Stories posted', points: layOn(buckets, rows) }],
    };
  }

  /**
   * Age band against gender, over Connect profile owners.
   *
   * The cell most worth suppressing on the whole tab: "25–34 · non-binary · 1" on a self-selected
   * dating-adjacent group names somebody to anybody who knows one fact about them. Every cell is a
   * member count, so the floor does its work before this leaves the process.
   */
  private async ageGender(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: ConnectFilters,
  ): Promise<MatrixChart> {
    const bands = await this.bands();
    const genderLabels = await this.taxonomy.labels(TaxonomyKind.GENDER);
    const band = this.bandExpression(bands, range.to);

    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ row: string | null; col: string | null; total: bigint }>>`
        WITH ${this.pop(filter, extra)}
        SELECT ${band} AS row, pop."gender" AS col, COUNT(*) AS total
        FROM pop
        WHERE pop."created_at" < ${range.toInstant}
        GROUP BY 1, 2
      `,
    );

    return toMatrix(rows, {
      rows: [
        ...bands.map(entry => ({ key: entry.code, label: entry.label })),
        { key: 'UNKNOWN', label: 'No date of birth' },
      ],
      cols: GENDERS.map(gender => ({
        key: gender,
        label: gender === 'UNKNOWN' ? 'Not said' : (genderLabels.get(gender) ?? gender),
      })),
    });
  }

  private async dmPolicyMix(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: ConnectFilters,
  ): Promise<BreakdownChart> {
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ key: string | null; total: bigint }>>`
        WITH ${this.pop(filter, extra)}
        SELECT pop."dm_policy" AS key, COUNT(*) AS total
        FROM pop
        WHERE pop."created_at" < ${range.toInstant}
        GROUP BY 1
      `,
    );

    return toBreakdown(rows, {
      order: ['OPEN', 'REQUEST_FIRST'],
      labels: new Map([
        ['OPEN', 'Anyone can message'],
        ['REQUEST_FIRST', 'Request first'],
      ]),
    });
  }

  // ─── Shared with Demographics, by the same reasoning ───────────────────────

  private async bands(): Promise<
    Array<{ code: string; label: string; minAge: number; maxAge: number | null }>
  > {
    const terms = await this.taxonomy.list(TaxonomyKind.CONNECT_AGE_BAND, false);

    return terms
      .map(term => {
        const metadata = (term.metadata ?? {}) as { minAge?: number; maxAge?: number | null };

        return typeof metadata.minAge === 'number'
          ? {
              code: term.code,
              label: term.label,
              minAge: metadata.minAge,
              maxAge: metadata.maxAge ?? null,
            }
          : null;
      })
      .filter(
        (band): band is { code: string; label: string; minAge: number; maxAge: number | null } =>
          band !== null,
      );
  }

  /** The band a birth date falls in at the end of the range, from the taxonomy's own bounds. */
  private bandExpression(
    bands: Array<{ code: string; minAge: number; maxAge: number | null }>,
    to: string,
  ): Prisma.Sql {
    const at = londonMidnight(shiftDateOnly(to, 1));
    const branches = bands.map(entry => {
      const window = birthDateRangeForAges(entry.minAge, entry.maxAge ?? undefined, at);
      const tests = [
        window.earliest ? Prisma.sql`pop."date_of_birth" > ${window.earliest}` : null,
        window.latest ? Prisma.sql`pop."date_of_birth" <= ${window.latest}` : null,
      ].filter((test): test is Prisma.Sql => test !== null);

      return Prisma.sql`WHEN ${Prisma.join(tests, ' AND ')} THEN ${entry.code}`;
    });

    return Prisma.sql`CASE ${Prisma.join(branches, ' ')} END`;
  }
}

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
