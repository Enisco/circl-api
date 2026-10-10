import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '@/infrastructure';
import { EnforcementService } from '../services/enforcement.service';

/**
 * The admin API's own scheduled work.
 *
 * Separate from `PlatformJobsService` because of the boundary, and the boundary is right here:
 * member-facing code may not depend on admin code, and expiring a suspension is enforcement, which
 * the staff API owns. The practical consequence is the correct one — in a split deployment the
 * admin service ends its own suspensions rather than waiting on the member service to do it.
 */
@Injectable()
export class AdminJobsService {
  private readonly logger = new Logger(AdminJobsService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly database: PrismaService,
    private readonly enforcement: EnforcementService,
  ) {}

  /**
   * Every five minutes, because the person waiting cannot tell anybody.
   *
   * A suspension that outlives its end date keeps somebody out by mistake, and they have no way to
   * report it: they cannot sign in to say so. Five minutes is the difference between "it ended
   * when it said it would" and "it ended when somebody next looked".
   */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'enforcement.expire-suspensions' })
  async expireSuspensions() {
    await this.run('enforcement.expire-suspensions', async () => {
      const lifted = await this.enforcement.expireSuspensions();

      return lifted ? `ended ${lifted} suspension(s)` : null;
    });
  }

  /**
   * Rebuilds `mv_member_dimensions` every fifteen minutes (§8.2).
   *
   * `CONCURRENTLY`, so readers are never blocked — a refresh that locks the view would stall every
   * open analytics tab for as long as it took, which at a hundred thousand members is long enough
   * to notice. The cost of `CONCURRENTLY` is that it needs a unique index and writes a second copy
   * before swapping; both are cheap next to a stalled dashboard.
   *
   * Fifteen minutes of staleness is invisible in a demographic breakdown, and deliberately **not**
   * what the member list reads: that one has to show somebody who signed up a minute ago, so it
   * queries the live tables.
   */
  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'analytics.refresh-member-dimensions' })
  async refreshMemberDimensions() {
    await this.run('analytics.refresh-member-dimensions', async () => {
      await this.database.$executeRawUnsafe(
        'REFRESH MATERIALIZED VIEW CONCURRENTLY "mv_member_dimensions"',
      );

      return 'refreshed';
    });
  }

  private onDemand = false;

  private readonly onDemandJobs: Record<string, () => Promise<void>> = {
    'enforcement.expire-suspensions': () => this.expireSuspensions(),
    // On demand as well as on a schedule, because the first thing anybody does after a seed or a
    // backfill is open the dashboard and find it fifteen minutes out of date.
    'analytics.refresh-member-dimensions': () => this.refreshMemberDimensions(),
  };

  async runNow(name: string): Promise<boolean> {
    const job = this.onDemandJobs[name];

    if (!job) return false;

    this.onDemand = true;

    try {
      await job();
    } finally {
      this.onDemand = false;
    }

    return true;
  }

  /** The same wrapper the platform jobs use: one failure must not take the others down. */
  private async run(name: string, work: () => Promise<string | null>): Promise<void> {
    if (!this.onDemand && this.config.get<string>('DISABLE_SCHEDULED_JOBS') === 'true') return;

    const started = Date.now();

    try {
      const summary = await work();

      if (summary) this.logger.log(`${name}: ${summary} (${Date.now() - started}ms)`);
    } catch (error) {
      this.logger.error(`${name} failed: ${(error as Error).message}`, (error as Error).stack);

      if (this.onDemand) throw error;
    }
  }
}
