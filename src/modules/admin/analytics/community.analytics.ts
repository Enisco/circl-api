import { Injectable } from '@nestjs/common';
import { Prisma, TaxonomyKind } from '@prisma/client';
import { TaxonomyService } from '@/modules/platform/shared';
import { AnalyticsRunnerService } from './analytics-runner.service';
import {
  BreakdownChart,
  Chart,
  GaugeChart,
  Num,
  Point,
  TableChart,
  TimeSeriesChart,
} from './chart.types';
import { Bucket, bucketsFor, indexByDay } from './buckets';
import { toBreakdown } from './breakdown';
import { ResolvedMemberFilter, ResolvedRange } from '../filters/member-filter.builder';
import { CommunityFilters } from '../dtos/admin-analytics.dto';

/** How long an open request with no reply has to sit before it counts as unanswered. */
const UNANSWERED_HOURS = 48;

/**
 * The Community tab (§5.25).
 *
 * The first tab that counts **content** rather than members, which changes what the shared filter
 * means: a member filter narrows the *author*, not the row. "Requests created by members in Leeds
 * aged 25–34" is the question, and `cityIds` is the one exception — a request has a city of its
 * own, so the filter applies to the content's city and the response says so in
 * `meta.filterSemantics` rather than leaving the reader to guess which it was.
 *
 * Deleted content is **included** in the creation counts, on purpose: the chart measures how much
 * was made, and a post that was written and then removed was still written. Everywhere that
 * measures what is *available* excludes it.
 */
@Injectable()
export class CommunityAnalytics {
  constructor(
    private readonly runner: AnalyticsRunnerService,
    private readonly taxonomy: TaxonomyService,
  ) {}

  /** What `cityIds` means here, for `meta.filterSemantics`. */
  static readonly FILTER_SEMANTICS: Record<string, string> = {
    cityIds: "the content's own city, not the author's",
  };

  charts(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: CommunityFilters,
  ): Record<string, () => Promise<Chart>> {
    return {
      created: () => this.created(filter, range, extra),
      requestsByCategory: () => this.requestsByCategory(filter, range, extra),
      requestOutcomes: () => this.requestOutcomes(filter, range, extra),
      responseTimes: () => this.responseTimes(filter, range, extra),
      unansweredByCity: () => this.unansweredByCity(filter, extra),
      visibilityMix: () => this.visibilityMix(filter, range, extra),
      topGuides: () => this.topGuides(filter, range, extra),
      guideDeflection: () => this.guideDeflection(filter, range),
      groups: () => this.groups(filter, range, extra),
      engagement: () => this.engagement(filter, range),
    };
  }

  /**
   * The authors, as a CTE.
   *
   * Content charts join to this rather than filtering rows: the shared filter describes people, and
   * a request has no gender. Without the join a city filter would silently mean "requests in
   * Leeds" on one chart and "requests by members in Leeds" on the next.
   */
  private pop(filter: ResolvedMemberFilter): Prisma.Sql {
    return Prisma.sql`
      pop AS (
        SELECT m."user_id" FROM "mv_member_dimensions" m WHERE ${filter.viewSql}
      )`;
  }

  /**
   * Every tab filter that applies to a table, in one place.
   *
   * Built as a single `AND …` fragment per table rather than one helper per filter, because the
   * first version applied them chart by chart and got it wrong in three places: `categories` and
   * `visibility` reached one chart each and `requestStatuses` reached none at all. A filter the
   * endpoint accepts and silently ignores is worse than one it refuses — the reader gets a chart
   * that answers a different question under the heading they chose.
   *
   * A column is passed as `null` where the table does not have it, so each call site says exactly
   * which of the four that table can honour.
   */
  private scope(
    extra: CommunityFilters,
    columns: {
      city?: Prisma.Sql;
      category?: Prisma.Sql;
      visibility?: Prisma.Sql;
      status?: Prisma.Sql;
    },
  ): Prisma.Sql {
    const parts: Prisma.Sql[] = [];

    if (columns.city && extra.cityIds?.length) {
      parts.push(Prisma.sql`${columns.city} IN (${Prisma.join(extra.cityIds)})`);
    }

    if (columns.category && extra.categories?.length) {
      parts.push(Prisma.sql`${columns.category} IN (${Prisma.join(extra.categories)})`);
    }

    if (columns.visibility && extra.visibility?.length) {
      parts.push(Prisma.sql`${columns.visibility}::text IN (${Prisma.join(extra.visibility)})`);
    }

    if (columns.status && extra.requestStatuses?.length) {
      parts.push(Prisma.sql`${columns.status}::text IN (${Prisma.join(extra.requestStatuses)})`);
    }

    return parts.length ? Prisma.sql`AND ${Prisma.join(parts, ' AND ')}` : Prisma.empty;
  }

  // ─── Creation volume ───────────────────────────────────────────────────────

  /** Requests, offers and posts created per bucket — deleted ones included. */
  private async created(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: CommunityFilters,
  ): Promise<TimeSeriesChart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ kind: string; day: Date; total: bigint }>>`
        WITH ${this.pop(filter)},
        made AS (
          SELECT 'requests' AS kind,
                 (r."created_at" AT TIME ZONE 'Europe/London')::date AS day
          FROM "community_requests" r
          JOIN pop ON pop."user_id" = r."author_id"
          WHERE r."created_at" >= ${range.fromInstant} AND r."created_at" < ${range.toInstant}
            ${this.scope(extra, {
              city: Prisma.sql`r."city_id"`,
              category: Prisma.sql`r."category_code"`,
              visibility: Prisma.sql`r."visibility"`,
              status: Prisma.sql`r."status"`,
            })}
          UNION ALL
          SELECT 'offers' AS kind,
                 (o."created_at" AT TIME ZONE 'Europe/London')::date AS day
          FROM "community_offers" o
          JOIN pop ON pop."user_id" = o."author_id"
          WHERE o."created_at" >= ${range.fromInstant} AND o."created_at" < ${range.toInstant}
            ${this.scope(extra, {
              city: Prisma.sql`o."city_id"`,
              category: Prisma.sql`o."category_code"`,
              visibility: Prisma.sql`o."visibility"`,
            })}
          UNION ALL
          SELECT 'posts' AS kind,
                 (u."created_at" AT TIME ZONE 'Europe/London')::date AS day
          FROM "community_updates" u
          JOIN pop ON pop."user_id" = u."author_id"
          WHERE u."created_at" >= ${range.fromInstant} AND u."created_at" < ${range.toInstant}
            ${this.scope(extra, {
              city: Prisma.sql`u."city_id"`,
              visibility: Prisma.sql`u."visibility"`,
            })}
        )
        SELECT kind, day, COUNT(*) AS total FROM made GROUP BY 1, 2
      `,
    );

    return {
      kind: 'timeseries',
      granularity: range.granularity,
      unit: 'count',
      series: ['requests', 'offers', 'posts'].map(key => ({
        key,
        label: key.charAt(0).toUpperCase() + key.slice(1),
        points: layOnBuckets(
          buckets,
          rows.filter(row => row.kind === key),
        ),
      })),
    };
  }

  private async requestsByCategory(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: CommunityFilters,
  ): Promise<BreakdownChart> {
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ key: string | null; total: bigint }>>`
        WITH ${this.pop(filter)}
        SELECT r."category_code" AS key, COUNT(*) AS total
        FROM "community_requests" r
        JOIN pop ON pop."user_id" = r."author_id"
        WHERE r."created_at" >= ${range.fromInstant} AND r."created_at" < ${range.toInstant}
          ${this.scope(extra, {
            city: Prisma.sql`r."city_id"`,
            category: Prisma.sql`r."category_code"`,
            visibility: Prisma.sql`r."visibility"`,
            status: Prisma.sql`r."status"`,
          })}
        GROUP BY 1
      `,
    );

    return toBreakdown(rows, {
      unit: 'count',
      labels: await this.taxonomy.labels(TaxonomyKind.COMMUNITY_CATEGORY),
    });
  }

  /**
   * How requests ended.
   *
   * `EXPIRED` is a status rather than an outcome — nobody chose it, the clock did — so it is folded
   * in as a fourth bar. An open request has no outcome yet and is left out entirely: counting it as
   * a failure would make every chart of a recent range look like one.
   */
  private async requestOutcomes(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: CommunityFilters,
  ): Promise<BreakdownChart> {
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ key: string | null; total: bigint }>>`
        WITH ${this.pop(filter)}
        SELECT COALESCE(r."outcome"::text,
                        CASE WHEN r."status" = 'EXPIRED' THEN 'EXPIRED' END) AS key,
               COUNT(*) AS total
        FROM "community_requests" r
        JOIN pop ON pop."user_id" = r."author_id"
        WHERE r."created_at" >= ${range.fromInstant} AND r."created_at" < ${range.toInstant}
          AND (r."outcome" IS NOT NULL OR r."status" = 'EXPIRED')
          ${this.scope(extra, {
            city: Prisma.sql`r."city_id"`,
            category: Prisma.sql`r."category_code"`,
            visibility: Prisma.sql`r."visibility"`,
          })}
        GROUP BY 1
      `,
    );

    return toBreakdown(rows, {
      unit: 'count',
      order: ['HELPED', 'SOLVED_ELSEWHERE', 'NO_LONGER_NEEDED', 'EXPIRED'],
      labels: new Map([
        ['HELPED', 'Helped'],
        ['SOLVED_ELSEWHERE', 'Solved elsewhere'],
        ['NO_LONGER_NEEDED', 'No longer needed'],
        ['EXPIRED', 'Expired'],
      ]),
    });
  }

  /**
   * How long somebody waits for a first reply, and for the thing to be resolved.
   *
   * Medians, not means: one request that sat for three weeks drags a mean past every real
   * experience, and the number staff act on is "what does a typical person wait".
   */
  private async responseTimes(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: CommunityFilters,
  ): Promise<Chart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);
    const rows = await this.runner.query(
      tx => tx.$queryRaw<
        Array<{ day: Date; first_reply: number | null; resolution: number | null }>
      >`
        WITH ${this.pop(filter)},
        requests AS (
          SELECT r."id", r."created_at", r."resolved_at",
                 (r."created_at" AT TIME ZONE 'Europe/London')::date AS day,
                 (
                   SELECT MIN(rr."created_at") FROM "request_responses" rr
                   WHERE rr."request_id" = r."id" AND rr."deleted_at" IS NULL
                 ) AS first_response_at
          FROM "community_requests" r
          JOIN pop ON pop."user_id" = r."author_id"
          WHERE r."created_at" >= ${range.fromInstant} AND r."created_at" < ${range.toInstant}
            ${this.scope(extra, {
              city: Prisma.sql`r."city_id"`,
              category: Prisma.sql`r."category_code"`,
              visibility: Prisma.sql`r."visibility"`,
              status: Prisma.sql`r."status"`,
            })}
        )
        SELECT day,
               PERCENTILE_CONT(0.5) WITHIN GROUP (
                 ORDER BY EXTRACT(EPOCH FROM (first_response_at - "created_at")) / 60
               ) AS first_reply,
               PERCENTILE_CONT(0.5) WITHIN GROUP (
                 ORDER BY EXTRACT(EPOCH FROM ("resolved_at" - "created_at")) / 60
               ) AS resolution
        FROM requests
        GROUP BY 1
      `,
    );

    const index = indexByDay(buckets);
    const collect = (pick: 'first_reply' | 'resolution'): Point[] => {
      const perBucket: number[][] = buckets.map(() => []);

      for (const row of rows) {
        const position = index.get(dayKey(row.day));
        const value = row[pick];

        if (position !== undefined && value !== null) perBucket[position].push(value);
      }

      return buckets.map((bucket, position) => ({
        t: bucket.key,
        v: perBucket[position].length ? Math.round(median(perBucket[position])) : null,
      }));
    };

    const firstReply = collect('first_reply');
    const resolution = collect('resolution');

    return {
      kind: 'group',
      items: {
        medianFirstResponse: kpi(medianOf(firstReply), 'minutes'),
        medianResolution: kpi(medianOf(resolution), 'minutes'),
        trend: {
          kind: 'timeseries',
          granularity: range.granularity,
          unit: 'minutes',
          series: [
            { key: 'medianFirstResponse', label: 'To first reply', points: firstReply },
            { key: 'medianResolution', label: 'To resolution', points: resolution },
          ],
        },
      },
    };
  }

  /**
   * Where requests are going unanswered — the one chart on this tab about *now* rather than a range.
   *
   * Open, no reply, and older than two days. Not bounded by the date range on purpose: a backlog is
   * a current state, and showing "requests that went unanswered last March" would be a different
   * and much less useful chart.
   */
  private async unansweredByCity(
    filter: ResolvedMemberFilter,
    extra: CommunityFilters,
  ): Promise<BreakdownChart> {
    const cutoff = new Date(Date.now() - UNANSWERED_HOURS * 3_600_000);
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ key: string | null; label: string | null; total: bigint }>>`
        WITH ${this.pop(filter)}
        SELECT r."city_id" AS key, c."name" AS label, COUNT(*) AS total
        FROM "community_requests" r
        JOIN pop ON pop."user_id" = r."author_id"
        LEFT JOIN "cities" c ON c."id" = r."city_id"
        WHERE r."status" = 'OPEN' AND r."reply_count" = 0 AND r."deleted_at" IS NULL
          AND r."created_at" < ${cutoff}
          ${this.scope(extra, {
            city: Prisma.sql`r."city_id"`,
            category: Prisma.sql`r."category_code"`,
            visibility: Prisma.sql`r."visibility"`,
          })}
        GROUP BY 1, 2
      `,
    );

    return toBreakdown(rows, {
      unit: 'count',
      top: 15,
      labels: new Map(rows.filter(row => row.key).map(row => [row.key!, row.label ?? row.key!])),
    });
  }

  private async visibilityMix(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: CommunityFilters,
  ): Promise<BreakdownChart> {
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ key: string | null; total: bigint }>>`
        WITH ${this.pop(filter)},
        posted AS (
          SELECT r."visibility"::text AS visibility
          FROM "community_requests" r
          JOIN pop ON pop."user_id" = r."author_id"
          WHERE r."created_at" >= ${range.fromInstant} AND r."created_at" < ${range.toInstant}
            ${this.scope(extra, {
              city: Prisma.sql`r."city_id"`,
              category: Prisma.sql`r."category_code"`,
              visibility: Prisma.sql`r."visibility"`,
              status: Prisma.sql`r."status"`,
            })}
          UNION ALL
          SELECT u."visibility"::text AS visibility
          FROM "community_updates" u
          JOIN pop ON pop."user_id" = u."author_id"
          WHERE u."created_at" >= ${range.fromInstant} AND u."created_at" < ${range.toInstant}
            ${this.scope(extra, {
              city: Prisma.sql`u."city_id"`,
              visibility: Prisma.sql`u."visibility"`,
            })}
        )
        SELECT visibility AS key, COUNT(*) AS total FROM posted GROUP BY 1
      `,
    );

    return toBreakdown(rows, {
      unit: 'count',
      order: ['PUBLIC', 'ANONYMOUS', 'PRIVATE_TO_CIRCL'],
      labels: new Map([
        ['PUBLIC', 'Public'],
        ['ANONYMOUS', 'Anonymous'],
        ['PRIVATE_TO_CIRCL', 'Private to Circl'],
      ]),
    });
  }

  /**
   * The guides people actually read, with how many finished them.
   *
   * Reads come from `activity_events` in the range rather than from `guides.view_count`, which is a
   * lifetime counter — a year-old guide would top every chart forever. Completion is progress at or
   * above 95%: a guide read to the last paragraph and abandoned on the footer was read.
   */
  private async topGuides(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: CommunityFilters,
  ): Promise<TableChart> {
    const rows = await this.runner.query(
      tx => tx.$queryRaw<
        Array<{
          guide_id: string;
          title: string;
          topic: string;
          reads: bigint;
          unique_readers: bigint;
          completions: bigint;
          likes: bigint;
        }>
      >`
        WITH ${this.pop(filter)},
        read_events AS (
          SELECT e."subject_id" AS guide_id, e."user_id"
          FROM "activity_events" e
          JOIN pop ON pop."user_id" = e."user_id"
          WHERE e."verb" = 'VIEW' AND e."subject" = 'GUIDE'
            AND e."subject_id" IS NOT NULL
            AND e."occurred_at" >= ${range.fromInstant} AND e."occurred_at" < ${range.toInstant}
        )
        SELECT g."id" AS guide_id, g."title" AS title, g."topic_code" AS topic,
               COUNT(r."guide_id") AS reads,
               COUNT(DISTINCT r."user_id") AS unique_readers,
               (
                 SELECT COUNT(*) FROM "guide_progress" gp
                 WHERE gp."guide_id" = g."id" AND gp."progress" >= 0.95
               ) AS completions,
               (SELECT COUNT(*) FROM "guide_reactions" gr WHERE gr."guide_id" = g."id") AS likes
        FROM "guides" g
        JOIN read_events r ON r."guide_id" = g."id"
        WHERE g."deleted_at" IS NULL
          ${extra.guideTopics?.length ? Prisma.sql`AND g."topic_code" IN (${Prisma.join(extra.guideTopics)})` : Prisma.empty}
        GROUP BY 1, 2, 3
        ORDER BY reads DESC
        LIMIT 20
      `,
    );

    const topics = await this.taxonomy.labels(TaxonomyKind.GUIDE_TOPIC);

    return {
      kind: 'table',
      columns: [
        { key: 'guideId', label: 'Guide' },
        { key: 'title', label: 'Title' },
        { key: 'topic', label: 'Topic' },
        { key: 'reads', label: 'Reads', unit: 'count' },
        { key: 'uniqueReaders', label: 'Readers', unit: 'members' },
        { key: 'completions', label: 'Completions', unit: 'count' },
        { key: 'likes', label: 'Likes', unit: 'count' },
      ],
      rows: rows.map(row => ({
        guideId: row.guide_id,
        title: row.title,
        topic: topics.get(row.topic) ?? row.topic,
        reads: Number(row.reads),
        uniqueReaders: Number(row.unique_readers),
        completions: Number(row.completions),
        likes: Number(row.likes),
      })),
    };
  }

  /**
   * Whether a guide answered the question somebody was about to ask.
   *
   * `ANSWERED ÷ (ANSWERED + POSTED_ANYWAY)` — the one metric on this tab that measures whether the
   * guides are doing their job rather than how many there are.
   */
  private async guideDeflection(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
  ): Promise<Chart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ day: Date; outcome: string; total: bigint }>>`
        WITH ${this.pop(filter)}
        SELECT (d."created_at" AT TIME ZONE 'Europe/London')::date AS day,
               d."outcome"::text AS outcome, COUNT(*) AS total
        FROM "guide_deflections" d
        JOIN pop ON pop."user_id" = d."user_id"
        WHERE d."created_at" >= ${range.fromInstant} AND d."created_at" < ${range.toInstant}
        GROUP BY 1, 2
      `,
    );

    const index = indexByDay(buckets);
    const answered = buckets.map(() => 0);
    const posted = buckets.map(() => 0);

    for (const row of rows) {
      const position = index.get(dayKey(row.day));

      if (position === undefined) continue;

      if (row.outcome === 'ANSWERED') answered[position] += Number(row.total);
      else posted[position] += Number(row.total);
    }

    const totalAnswered = answered.reduce((sum, value) => sum + value, 0);
    const totalPosted = posted.reduce((sum, value) => sum + value, 0);
    const overall = totalAnswered + totalPosted;

    const gauge: GaugeChart = {
      kind: 'gauge',
      // Null rather than zero where nobody was offered a guide: a rate of 0% reads as "the guides
      // never help", and "nobody has been shown one" is a different statement.
      value: overall > 0 ? Math.round((totalAnswered / overall) * 1000) / 10 : null,
      previous: null,
      unit: 'percent',
    };

    return {
      kind: 'group',
      items: {
        rate: gauge,
        trend: {
          kind: 'timeseries',
          granularity: range.granularity,
          unit: 'percent',
          series: [
            {
              key: 'deflectionRate',
              label: 'Answered without posting',
              points: buckets.map((bucket, position) => {
                const seen = answered[position] + posted[position];

                return {
                  t: bucket.key,
                  v: seen > 0 ? Math.round((answered[position] / seen) * 1000) / 10 : null,
                };
              }),
            },
          ],
        },
      },
    };
  }

  /** Groups made and joined, plus the ones people are actually using. */
  private async groups(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: CommunityFilters,
  ): Promise<Chart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);
    const joinPolicy = extra.joinPolicy?.length
      ? Prisma.sql`AND g."join_policy"::text IN (${Prisma.join(extra.joinPolicy)})`
      : Prisma.empty;

    const [created, joined, active] = await Promise.all([
      this.runner.query(
        tx => tx.$queryRaw<Array<{ day: Date; total: bigint }>>`
          WITH ${this.pop(filter)}
          SELECT (g."created_at" AT TIME ZONE 'Europe/London')::date AS day, COUNT(*) AS total
          FROM "groups" g
          JOIN pop ON pop."user_id" = g."created_by_id"
          WHERE g."created_at" >= ${range.fromInstant} AND g."created_at" < ${range.toInstant}
            ${this.scope(extra, { city: Prisma.sql`g."city_id"` })} ${joinPolicy}
          GROUP BY 1
        `,
      ),
      this.runner.query(
        tx => tx.$queryRaw<Array<{ day: Date; total: bigint }>>`
          WITH ${this.pop(filter)}
          SELECT (gm."joined_at" AT TIME ZONE 'Europe/London')::date AS day, COUNT(*) AS total
          FROM "group_memberships" gm
          JOIN pop ON pop."user_id" = gm."user_id"
          WHERE gm."joined_at" >= ${range.fromInstant} AND gm."joined_at" < ${range.toInstant}
          GROUP BY 1
        `,
      ),
      this.runner.query(
        tx => tx.$queryRaw<
          Array<{
            group_id: string;
            name: string;
            city: string | null;
            members: number;
            posts: bigint;
            last_post_at: Date | null;
          }>
        >`
          SELECT g."id" AS group_id, g."name" AS name, c."name" AS city,
                 g."member_count" AS members,
                 (
                   SELECT COUNT(*) FROM "group_posts" p
                   WHERE p."group_id" = g."id" AND p."deleted_at" IS NULL
                     AND p."created_at" >= ${range.fromInstant}
                     AND p."created_at" < ${range.toInstant}
                 ) AS posts,
                 g."last_post_at" AS last_post_at
          FROM "groups" g
          LEFT JOIN "cities" c ON c."id" = g."city_id"
          WHERE g."deleted_at" IS NULL
            ${this.scope(extra, { city: Prisma.sql`g."city_id"` })} ${joinPolicy}
          ORDER BY posts DESC, g."member_count" DESC
          LIMIT 20
        `,
      ),
    ]);

    return {
      kind: 'group',
      items: {
        growth: {
          kind: 'timeseries',
          granularity: range.granularity,
          unit: 'count',
          series: [
            {
              key: 'groupsCreated',
              label: 'Groups created',
              points: layOnBuckets(buckets, created),
            },
            {
              key: 'membershipsJoined',
              label: 'Members joined',
              points: layOnBuckets(buckets, joined),
            },
          ],
        },
        mostActive: {
          kind: 'table',
          columns: [
            { key: 'groupId', label: 'Group' },
            { key: 'name', label: 'Name' },
            { key: 'city', label: 'City' },
            { key: 'members', label: 'Members', unit: 'members' },
            { key: 'postsInRange', label: 'Posts', unit: 'count' },
            { key: 'lastPostAt', label: 'Last post' },
          ],
          rows: active.map(row => ({
            groupId: row.group_id,
            name: row.name,
            city: row.city,
            members: Number(row.members),
            postsInRange: Number(row.posts),
            lastPostAt: row.last_post_at?.toISOString() ?? null,
          })),
        },
      },
    };
  }

  /**
   * Replies and reactions per post.
   *
   * A ratio rather than two counts, because the question is whether what people write gets a
   * response — and a month with twice the posts and twice the replies has not got livelier. Null
   * where nothing was posted in the bucket: dividing by zero posts is not a zero engagement rate.
   */
  private async engagement(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
  ): Promise<TimeSeriesChart> {
    const buckets = bucketsFor(range.from, range.to, range.granularity);
    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ kind: string; day: Date; total: bigint }>>`
        WITH ${this.pop(filter)},
        counted AS (
          SELECT 'posts' AS kind, (u."created_at" AT TIME ZONE 'Europe/London')::date AS day
          FROM "community_updates" u
          JOIN pop ON pop."user_id" = u."author_id"
          WHERE u."created_at" >= ${range.fromInstant} AND u."created_at" < ${range.toInstant}
          UNION ALL
          -- Every arm names its columns, although a UNION only reads the first arm's names.
          -- Without that, reordering the arms silently renames the result and the outer SELECT
          -- fails with "column does not exist" -- which is how ?targetType=GUIDE broke the member
          -- content tab.
          SELECT 'replies' AS kind, (r."created_at" AT TIME ZONE 'Europe/London')::date AS day
          FROM "update_replies" r
          JOIN pop ON pop."user_id" = r."author_id"
          WHERE r."created_at" >= ${range.fromInstant} AND r."created_at" < ${range.toInstant}
          UNION ALL
          SELECT 'reactions' AS kind, (x."created_at" AT TIME ZONE 'Europe/London')::date AS day
          FROM "update_reactions" x
          JOIN pop ON pop."user_id" = x."user_id"
          WHERE x."created_at" >= ${range.fromInstant} AND x."created_at" < ${range.toInstant}
        )
        SELECT kind, day, COUNT(*) AS total FROM counted GROUP BY 1, 2
      `,
    );

    const index = indexByDay(buckets);
    const per = {
      posts: buckets.map(() => 0),
      replies: buckets.map(() => 0),
      reactions: buckets.map(() => 0),
    };

    for (const row of rows) {
      const position = index.get(dayKey(row.day));

      if (position === undefined) continue;

      per[row.kind as keyof typeof per][position] += Number(row.total);
    }

    const ratioOf = (numerator: number[]): Point[] =>
      buckets.map((bucket, position) => ({
        t: bucket.key,
        v:
          per.posts[position] > 0
            ? Math.round((numerator[position] / per.posts[position]) * 100) / 100
            : null,
      }));

    return {
      kind: 'timeseries',
      granularity: range.granularity,
      unit: 'ratio',
      series: [
        { key: 'repliesPerPost', label: 'Replies per post', points: ratioOf(per.replies) },
        { key: 'reactionsPerPost', label: 'Reactions per post', points: ratioOf(per.reactions) },
      ],
    };
  }
}

const kpi = (value: Num, unit: 'minutes'): Chart => ({
  kind: 'kpi',
  value,
  previous: null,
  changePct: null,
  unit,
  sparkline: [],
});

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** The median of a series' own points, for the headline beside it. */
const medianOf = (points: Point[]): Num => {
  const values = points.map(point => point.v).filter((value): value is number => value !== null);

  return values.length ? Math.round(median(values)) : null;
};

const dayKey = (day: Date): string => day.toISOString().slice(0, 10);

const layOnBuckets = (buckets: Bucket[], rows: Array<{ day: Date; total: bigint }>): Point[] => {
  const index = indexByDay(buckets);
  const totals = buckets.map(() => 0);

  for (const row of rows) {
    const position = index.get(dayKey(row.day));

    if (position !== undefined) totals[position] += Number(row.total);
  }

  return buckets.map((bucket, position) => ({ t: bucket.key, v: totals[position] }));
};
