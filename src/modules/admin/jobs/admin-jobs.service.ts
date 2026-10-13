import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { QueueJobStatus } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException, CRON_RUN, JobFailure, JobRunContext } from '@/common';
import { AuditChainService } from '../audit/audit-chain.service';
import { AdminExportService } from '../exports/admin-export.service';
import { RetentionPurgeService } from './retention-purge.service';
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
    private readonly exports: AdminExportService,
    private readonly chain: AuditChainService,
    private readonly retention: RetentionPurgeService,
  ) {}

  /**
   * Every five minutes, because the person waiting cannot tell anybody.
   *
   * A suspension that outlives its end date keeps somebody out by mistake, and they have no way to
   * report it: they cannot sign in to say so. Five minutes is the difference between "it ended
   * when it said it would" and "it ended when somebody next looked".
   */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'enforcement.expire-suspensions' })
  async expireSuspensions(context: JobRunContext = CRON_RUN) {
    await this.run(
      'enforcement.expire-suspensions',
      async () => {
        const lifted = await this.enforcement.expireSuspensions();

        return lifted ? `ended ${lifted} suspension(s)` : null;
      },
      context,
    );
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
  async refreshMemberDimensions(context: JobRunContext = CRON_RUN) {
    await this.run(
      'analytics.refresh-member-dimensions',
      async () => {
        await this.database.$executeRawUnsafe(
          'REFRESH MATERIALIZED VIEW CONCURRENTLY "mv_member_dimensions"',
        );

        return 'refreshed';
      },
      context,
    );
  }

  /**
   * Hourly, which is as late as a seven-day deletion may be.
   *
   * §13.6 keeps an export's file for seven days and the row for a year. A daily sweep would leave
   * a file of member contact details in the bucket for up to a day after it was promised gone,
   * and the whole point of the seven days is that the file stops existing on its own. The row
   * purge and the abandoned-job cleanup ride along in the same pass (see `expire`).
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'exports.expire' })
  async expireExports(context: JobRunContext = CRON_RUN) {
    await this.run(
      'exports.expire',
      async () => {
        const { expired, purged, abandoned } = await this.exports.expire();

        return expired || purged || abandoned
          ? `expired ${expired} file(s), failed ${abandoned} abandoned, purged ${purged} row(s)`
          : null;
      },
      context,
    );
  }

  /**
   * Nightly, which is as often as tamper evidence is worth anything (S11.3).
   *
   * At 02:00, after the 01:30 analytics rollups: this reads the newest segments in full, and the
   * two are better off not sharing a window. It shares the slot with `intelligence.auto-guides`,
   * which is a platform job and therefore not in this process on the staff host.
   *
   * A failure here is the alert. `run` throws when verification finds a difference, which marks
   * the run FAILED in §5.22's history and writes a `securityEvent` the log pipeline watches — the
   * two places somebody would look, rather than a summary string that reads green.
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM, { name: 'audit.verify-chain' })
  async verifyAuditChain(context: JobRunContext = CRON_RUN) {
    await this.run('audit.verify-chain', () => this.chain.run(), context);
  }

  /**
   * §13.6's retention table, nightly at 03:00.
   *
   * After the chain job at 02:00, and that order matters: the purge removes whole sealed stretches
   * of the trail, so a run that seals first has the stretch it is allowed to drop. The hour is the
   * spec's, and it is the quietest one for a job that deletes from a dozen tables.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'retention.purge' })
  async purgeRetention(context: JobRunContext = CRON_RUN) {
    await this.run('retention.purge', () => this.retention.run(), context);
  }

  private readonly onDemandJobs: Record<string, (context: JobRunContext) => Promise<void>> = {
    'enforcement.expire-suspensions': context => this.expireSuspensions(context),
    // On demand as well as on a schedule, because the first thing anybody does after a seed or a
    // backfill is open the dashboard and find it fifteen minutes out of date.
    'analytics.refresh-member-dimensions': context => this.refreshMemberDimensions(context),
    // On demand as well, so an operator can make the seven-day boundary happen now rather than
    // waiting for the hour — and so the end-to-end checks can prove the sweep rather than trust it.
    'exports.expire': context => this.expireExports(context),
    // On demand as well, so the chain can be sealed and checked the moment somebody suspects
    // something rather than at two in the morning — and so the end-to-end checks can prove the
    // detection rather than trust it.
    'audit.verify-chain': context => this.verifyAuditChain(context),
    // On demand as well, so a retention question can be answered now rather than tomorrow — and
    // so the end-to-end checks can prove each rule rather than trust the dates in the table.
    'retention.purge': context => this.purgeRetention(context),
  };

  async runNow(name: string, actorId?: string): Promise<boolean> {
    const job = this.onDemandJobs[name];

    if (!job) return false;

    await job({ trigger: 'MANUAL', actorId: actorId ?? null });

    return true;
  }

  /** The same wrapper the platform jobs use: one failure must not take the others down. */
  private async run(
    name: string,
    work: () => Promise<string | null>,
    context: JobRunContext,
  ): Promise<void> {
    if (
      context.trigger === 'CRON' &&
      this.config.get<string>('DISABLE_SCHEDULED_JOBS') === 'true'
    ) {
      return;
    }

    const started = Date.now();
    const startedAt = new Date();

    try {
      const summary = await work();

      if (summary) this.logger.log(`${name}: ${summary} (${Date.now() - started}ms)`);

      await this.note(name, startedAt, started, context, QueueJobStatus.SUCCESS, summary);
    } catch (error) {
      this.logger.error(`${name} failed: ${(error as Error).message}`, (error as Error).stack);

      /**
       * The work it did before it failed is kept, not replaced by the error.
       *
       * `audit.verify-chain` seals the trail and then checks the seals: a run that sealed four
       * stretches and found a difference in a fifth has done something worth recording, and a
       * history row that says only "verification failed" loses it.
       */
      const summary = error instanceof JobFailure ? error.summary : null;

      await this.note(
        name,
        startedAt,
        started,
        context,
        QueueJobStatus.FAILED,
        summary,
        (error as Error).message,
      );

      /**
       * A manual run answers with the failure; a scheduled one has nobody to answer.
       *
       * As an `ApiException` rather than the original error, because the original became a 500
       * "Something went wrong" — so a `verify-chain` mismatch, which is the one job whose failure
       * is a *finding*, reached the staff member as a shrug. The run's own error is the message.
       */
      if (context.trigger === 'MANUAL') {
        throw ApiException.conflict(
          ApiErrorCode.JOB_FAILED,
          `${name} ran and failed: ${(error as Error).message}`,
          { data: { job: name, summary } },
        );
      }
    }
  }

  /**
   * One `QueueJobLog` row per run (§4.11, B19).
   *
   * A second copy of `PlatformJobsService.note`, which is the price of the surface split: these
   * jobs run in the admin process and those in the member one, and a shared writer would be a new
   * module both sides import for one insert. The two must stay the same shape, because §5.22's run
   * list reads them as one history — hence the identical `queueName` convention and columns.
   *
   * Never throws: a job that did its work and could not write its own history row has still done
   * its work.
   */
  private async note(
    name: string,
    startedAt: Date,
    startedMs: number,
    context: JobRunContext,
    status: QueueJobStatus,
    summary: string | null,
    error?: string,
  ): Promise<void> {
    try {
      await this.database.queueJobLog.create({
        data: {
          queueName: 'admin-jobs',
          operation: name,
          status,
          trigger: context.trigger,
          userId: context.actorId,
          startedAt,
          durationMs: Date.now() - startedMs,
          error: error ? error.slice(0, 1000) : null,
          metadata: summary ? { summary } : undefined,
        },
      });
    } catch (failure) {
      this.logger.warn(`${name}: run not recorded — ${(failure as Error).message}`);
    }
  }
}
