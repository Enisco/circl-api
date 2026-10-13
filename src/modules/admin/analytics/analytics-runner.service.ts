import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { CacheService, PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException, SYSTEM_CONFIG_KEYS, londonDateString } from '@/common';
import { SystemConfigService } from '@/modules/platform/shared';
import { Chart } from './chart.types';
import { suppressChart } from './suppression';

/** How many charts of one tab are computed at once (§8.4). */
const CHART_CONCURRENCY = 4;

/** How many analytics computations one staff member may have in flight (§8.4). */
const PER_STAFF_LIMIT = 4;

/** How long a single-flight lock is held before another caller gives up waiting on it. */
const LOCK_MS = 30_000;

/** How long a concurrency slot can be held before it frees itself. Longer than any one query. */
const SLOT_MS = 60_000;

/** The ceiling on one analytics query. Beyond this the answer is not worth the table lock. */
const STATEMENT_TIMEOUT = '10s';

/** Postgres's default is 4MB, which turns a sort over a year of member-days into a disk sort. */
const WORK_MEM = '64MB';

export interface CacheOutcome {
  hit: boolean;
  ttlSeconds: number;
}

/**
 * How an analytics chart is computed, cached and kept from taking the database with it.
 *
 * Everything expensive about the portal happens here. A tab is a dozen queries over the whole
 * members table, a staff member moving a filter chip re-runs all of them, and four people doing
 * that at once is forty queries — so this file is five limits, each for a failure somebody has
 * actually had:
 *
 *  - **A cache**, keyed on the normalised filters *and the caller's scope*, because two roles can
 *    ask the same question and be entitled to different answers.
 *  - **Single-flight**, so ten identical requests are one computation and nine waits. Without it a
 *    dashboard that everybody opens at nine o'clock is the thundering herd.
 *  - **A statement timeout**, so a query nobody will wait for is cancelled rather than held.
 *  - **A per-staff semaphore**, so one person holding a filter key down cannot starve the rest.
 *  - **Per-chart isolation**, so one failed chart is one empty panel rather than a blank tab.
 */
@Injectable()
export class AnalyticsRunnerService {
  private readonly logger = new Logger(AnalyticsRunnerService.name);

  constructor(
    private readonly database: PrismaService,
    private readonly cache: CacheService,
    private readonly config: SystemConfigService,
  ) {}

  /**
   * Runs a query with the limits a reporting query needs and a product query does not.
   *
   * `SET LOCAL` inside a transaction, so both settings end with it rather than leaking onto the
   * next thing the pooled connection does — a `work_mem` of 64MB left behind on a connection
   * serving the member feed is a memory bill nobody can trace.
   */
  /**
   * How many members a filter selects, for §2.7's population floor.
   *
   * Here rather than in `AdminAnalyticsService` because the **dashboard** needs the same number and
   * had none: a narrow city filter showed figures for fewer than ten people and
   * `meta.populationSuppressed` was never set, so the one screen everybody opens was the one
   * without the floor on it.
   *
   * Zero is not "narrow". An empty selection is somebody asking about a city with nobody in it,
   * and answering "withheld" would imply there is something to withhold.
   */
  async populationSize(viewSql: Prisma.Sql): Promise<number> {
    const [row] = await this.query(
      tx => tx.$queryRaw<Array<{ total: bigint }>>`
        SELECT COUNT(*) AS total FROM "mv_member_dimensions" m WHERE ${viewSql}
      `,
    );

    return Number(row?.total ?? 0);
  }

  async query<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.database.$transaction(async tx => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
        await tx.$executeRawUnsafe(`SET LOCAL work_mem = '${WORK_MEM}'`);

        return run(tx);
      });
    } catch (error) {
      // 57014 is `query_canceled`, which here only ever means the statement timeout fired.
      if ((error as { meta?: { code?: string } })?.meta?.code === '57014') {
        throw ApiException.unavailable(
          ApiErrorCode.ANALYTICS_TIMEOUT,
          'That took too long to work out. Narrow the date range or the filters.',
        );
      }

      throw error;
    }
  }

  /**
   * Computes a tab's charts, in parallel, with each one's failure kept to itself.
   *
   * Bounded at four: a tab of twelve charts firing twelve concurrent full-table scans is slower
   * than four at a time, because they queue in the database instead of in the process, where at
   * least the timeout can see them.
   */
  async charts(
    key: string,
    wanted: Record<string, () => Promise<Chart>>,
    options: { includesToday: boolean },
  ): Promise<{ charts: Record<string, Chart>; cache: CacheOutcome }> {
    const ttl = await this.ttlFor(options.includesToday);
    const ids = Object.keys(wanted);
    const results: Record<string, Chart> = {};
    let hits = 0;

    for (let start = 0; start < ids.length; start += CHART_CONCURRENCY) {
      const slice = ids.slice(start, start + CHART_CONCURRENCY);

      await Promise.all(
        slice.map(async id => {
          const { chart, hit } = await this.chart(`${key}:${id}`, wanted[id], ttl);

          results[id] = chart;

          if (hit) hits += 1;
        }),
      );
    }

    // A tab counts as a cache hit only when every chart came from the cache: a partial hit is a
    // computation, and reporting it as a hit would make the numbers in `meta.cache` meaningless.
    return {
      charts: results,
      cache: { hit: ids.length > 0 && hits === ids.length, ttlSeconds: ttl },
    };
  }

  /**
   * One chart: cached, single-flighted, suppressed, and never allowed to throw.
   *
   * Suppression runs before the write, so what is cached is already safe to hand to anybody with
   * that tab's permission (§8.4) — and a bug in a later read path cannot un-suppress it.
   */
  private async chart(
    key: string,
    compute: () => Promise<Chart>,
    ttl: number,
  ): Promise<{ chart: Chart; hit: boolean }> {
    try {
      const cached = await this.cache.get<{ chart: Chart }>(key);

      if (cached) return { chart: cached.chart, hit: true };

      const mine = await this.cache.setIfAbsent(`${key}:lock`, 1, LOCK_MS);

      if (!mine) {
        // Somebody else is computing it. Wait briefly for their answer rather than starting a
        // second identical scan; if it does not arrive, compute it anyway — a slow chart is better
        // than a missing one, and the lock expires on its own.
        const shared = await this.waitFor(key);

        if (shared) return { chart: shared, hit: true };
      }

      const chart = suppressChart(await compute());

      await this.cache.set(key, { chart }, ttl);

      return { chart, hit: false };
    } catch (error) {
      const code = error instanceof ApiException ? error.code : ApiErrorCode.INTERNAL_ERROR;

      this.logger.warn({
        event: 'analytics_chart_failed',
        key,
        code,
        message: (error as Error).message,
      });

      // In the payload, not as a status. A tab of twelve charts must not go blank because one of
      // them failed (§8.4).
      return { chart: { kind: 'error', code }, hit: false };
    } finally {
      await this.cache.delete(`${key}:lock`).catch(() => undefined);
    }
  }

  /** Polls for the holder's answer for up to two seconds, then gives up and computes it. */
  private async waitFor(key: string): Promise<Chart | null> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 200));

      const cached = await this.cache.get<{ chart: Chart }>(key);

      if (cached) return cached.chart;
    }

    return null;
  }

  /**
   * The cache key: the tab, the filters, and who is asking.
   *
   * The scope is in the key because two staff members can send identical filters and be entitled
   * to different answers — a `reports:read`-only caller sees a report breakdown with no reporter
   * identities in it. A key without the scope would serve one of them the other's payload, which is
   * the kind of cache bug that reads as a permission bug for months.
   *
   * Filters are normalised first — sorted arrays, dropped empties — so that `cityIds=A,B` and
   * `cityIds=B,A` are one entry rather than two.
   */
  keyFor(tab: string, filters: Record<string, unknown>, scope: string): string {
    const normalised = Object.entries(filters)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([field, value]): [string, unknown] => [
        field,
        Array.isArray(value) ? [...value].map(String).sort() : value,
      ])
      .sort(([a], [b]) => a.localeCompare(b));

    const digest = createHash('sha256')
      .update(JSON.stringify({ filters: normalised, scope }))
      .digest('hex')
      .slice(0, 32);

    return `analytics:v1:${tab}:${digest}`;
  }

  /** Shorter for a range that includes today, because today is still changing. */
  private async ttlFor(includesToday: boolean): Promise<number> {
    const ttl = await this.config.get(SYSTEM_CONFIG_KEYS.ANALYTICS_CACHE_TTL_SECONDS);

    return includesToday ? ttl.today : ttl.historical;
  }

  /** Whether a range reaches today, which decides how long its answer is worth keeping. */
  includesToday(to: string): boolean {
    return to >= londonDateString();
  }

  /**
   * Claims one of a staff member's four concurrent slots, or refuses.
   *
   * The failure it guards against is one person's open dashboard retrying in a loop. Released in a
   * `finally`, and each slot expires on its own if the process dies holding it — a semaphore that
   * can be leaked permanently is worse than no semaphore at all.
   */
  async withSlot<T>(actorId: string, work: () => Promise<T>): Promise<T> {
    const slot = await this.claimSlot(actorId);

    if (slot === null) {
      throw ApiException.rateLimited(
        ApiErrorCode.RATE_LIMITED,
        'Too many charts at once. Let the current ones finish.',
      );
    }

    try {
      return await work();
    } finally {
      await this.cache.delete(slot).catch(() => undefined);
    }
  }

  /**
   * Four named slots, each taken with `SET NX`, rather than one counter.
   *
   * A counter has to be read and then written, and two requests arriving together both read the
   * same number — so the count drifts. Drifting *down* lets a fifth request through, which is
   * harmless. Drifting *up* is not: every release rewrote the key with a fresh TTL, so a busy staff
   * member's inflated count never expired and they were locked out of their own dashboard until
   * they stopped using it. `SET NX` on a named slot cannot drift — a slot is either held or it is
   * not — and each one expires on its own if the process dies holding it.
   */
  private async claimSlot(actorId: string): Promise<string | null> {
    for (let slot = 0; slot < PER_STAFF_LIMIT; slot += 1) {
      const key = `analytics:slot:${actorId}:${slot}`;

      if (await this.cache.setIfAbsent(key, 1, SLOT_MS)) return key;
    }

    return null;
  }
}
