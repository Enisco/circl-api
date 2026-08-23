import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '@/infrastructure';
import { MediaUploadService } from '../media/services/media-upload.service';
import { BookingService } from '../professionals/services/booking.service';
import { ProfessionalsHomeService } from '../professionals/services/professionals-home.service';
import { EnquiryService } from '../commerce/services/enquiry.service';
import { AutoGuideService } from '../intelligence/services/auto-guide.service';
import { DemandService } from '../intelligence/services/demand.service';
import { MetricsService } from '../intelligence/services/metrics.service';

/**
 * The scheduled work that keeps the platform's promises true between requests.
 *
 * Every job here exists because something in the spec is stated as a fact the
 * member can rely on — a booking closing after 7 days, an enquiry going stale
 * after 30, an orphaned upload not lingering, a dashboard being current. A fact
 * nothing enforces is a lie with a delay on it.
 *
 * Each runs independently and logs its own failure: one job erroring must not
 * stop the others, and a silent failure here is invisible until someone notices
 * a number is wrong.
 */
@Injectable()
export class PlatformJobsService {
  private readonly logger = new Logger(PlatformJobsService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly database: PrismaService,
    private readonly media: MediaUploadService,
    private readonly bookings: BookingService,
    private readonly enquiries: EnquiryService,
    private readonly professionals: ProfessionalsHomeService,
    private readonly demand: DemandService,
    private readonly autoGuides: AutoGuideService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * A booking auto-completes 7 days after delivery (2.9.5). The date is already
   * on the record and shown to both parties, so this is what makes it true.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'bookings.auto-complete' })
  async autoCompleteBookings() {
    await this.run('bookings.auto-complete', async () => {
      const closed = await this.bookings.runAutoComplete();

      return closed ? `closed ${closed} delivered bookings` : null;
    });
  }

  /**
   * D24: an enquiry nobody confirms goes stale after 30 days. It is never
   * auto-completed — confirming that someone received groceries they may never
   * have received is a claim Circl cannot make.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'enquiries.expire' })
  async expireEnquiries() {
    await this.run('enquiries.expire', async () => {
      const expired = await this.enquiries.runExpiry();

      return expired ? `expired ${expired} stale enquiries` : null;
    });
  }

  /**
   * Requests with a `neededOn` that has passed are no longer open questions.
   * Leaving them OPEN inflates every "questions we cannot answer" metric with
   * questions that stopped mattering.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'requests.expire' })
  async expireRequests() {
    await this.run('requests.expire', async () => {
      const cutoff = new Date();

      cutoff.setUTCHours(0, 0, 0, 0);

      const result = await this.database.communityRequest.updateMany({
        where: { status: 'OPEN', deletedAt: null, neededOn: { lt: cutoff } },
        data: { status: 'EXPIRED' },
      });

      return result.count ? `expired ${result.count} past-dated requests` : null;
    });
  }

  /**
   * Orphan media is deleted after 24 hours if never attached to a post (0.11).
   * The bytes go too, not just the row — an abandoned composer should not leave
   * a member's photographs sitting in a bucket.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'media.sweep-orphans' })
  async sweepOrphanMedia() {
    await this.run('media.sweep-orphans', async () => {
      const swept = await this.media.sweepOrphans();

      return swept ? `removed ${swept} orphaned uploads` : null;
    });
  }

  /** Idempotency records are worthless after their 24-hour window (0.12). */
  @Cron(CronExpression.EVERY_6_HOURS, { name: 'idempotency.sweep' })
  async sweepIdempotency() {
    await this.run('idempotency.sweep', async () => {
      const result = await this.database.idempotencyRecord.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });

      return result.count ? `removed ${result.count} expired idempotency records` : null;
    });
  }

  /**
   * `medianResponseMinutes` is one definition read by three surfaces: the
   * profile, the dashboard and the maxResponseHours filter (2.11). It is a scan
   * over messages, so it is computed here rather than per read.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM, { name: 'professionals.response-times' })
  async recomputeResponseTimes() {
    await this.run('professionals.response-times', async () => {
      const updated = await this.professionals.recomputeResponseTimes();

      return updated ? `updated ${updated} listings` : null;
    });
  }

  /**
   * Circl Intelligence: the demand rollup behind Guided Creation. Rebuilt on a
   * schedule so a composer never waits on an aggregate over the whole event
   * stream.
   */
  @Cron(CronExpression.EVERY_2_HOURS, { name: 'intelligence.demand' })
  async rebuildDemand() {
    await this.run('intelligence.demand', async () => {
      const written = await this.demand.rebuild();

      return written ? `rebuilt ${written} demand signals` : null;
    });
  }

  /**
   * Circl Intelligence: Auto-Guides. Drafts a guide when three or more members
   * have asked the same question, and queues it for a human — nothing published
   * here reaches a member unreviewed.
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM, { name: 'intelligence.auto-guides' })
  async draftAutoGuides() {
    await this.run('intelligence.auto-guides', async () => {
      const { clusters, drafted } = await this.autoGuides.run();

      return drafted ? `drafted ${drafted} guides from ${clusters} question clusters` : null;
    });
  }

  /** Circl Intelligence: the Pulse dashboards, precomputed per section per city. */
  @Cron(CronExpression.EVERY_DAY_AT_5AM, { name: 'intelligence.metrics' })
  async rebuildMetrics() {
    await this.run('intelligence.metrics', async () => {
      const monthly = await this.metrics.rebuild('MONTH');
      const weekly = await this.metrics.rebuild('WEEK');

      return `rebuilt ${monthly + weekly} metric snapshots`;
    });
  }

  /**
   * One wrapper so every job logs the same way and none can take the others
   * down with it. Silence means nothing needed doing, which is worth keeping
   * quiet: a job that logs every hour whether or not it did anything trains
   * people to ignore its output.
   */
  private async run(name: string, work: () => Promise<string | null>): Promise<void> {
    // Cron jobs run per instance. On a platform that scales horizontally this
    // wants a lock; with a single web service it is correct as it stands, and
    // every job here is idempotent so a double-run is harmless rather than wrong.
    if (this.config.get<string>('DISABLE_SCHEDULED_JOBS') === 'true') return;

    const started = Date.now();

    try {
      const summary = await work();

      if (summary) {
        this.logger.log(`${name}: ${summary} (${Date.now() - started}ms)`);
      }
    } catch (error) {
      this.logger.error(`${name} failed: ${(error as Error).message}`, (error as Error).stack);
    }
  }
}
