import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  ContentScanStatus,
  ContentScanTrigger,
  ContentVisibilityState,
  ListingReviewState,
  MediaScanStatus,
  ModerationDecision,
  ModerationQueueState,
  ModerationQueueType,
  NotificationKind,
  Prisma,
  QueueJobStatus,
  ReportTargetType,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { DataExportBuilderService } from '../account';
import { ApiErrorCode, ApiException, CRON_RUN, JobRunContext } from '@/common';
import {
  ContentSafetyQueue,
  ContentSafetyService,
  DOCUMENT_RETENTION_DAYS,
  LISTING_DOCUMENT_OWNER,
  LISTING_ROUTE,
  SCANNABLE_TARGETS,
  SafetyClassifierService,
} from '../shared';
import { StorageProvider } from '../media/storage';
import { NotificationFeedService } from '../notifications/services/notification-feed.service';
import { MediaDerivationService } from '../media/derivation/media-derivation.service';
import { SearchDemandService } from '../intelligence/services/search-demand.service';
import { MediaUploadService } from '../media/services/media-upload.service';
import { BookingService } from '../professionals/services/booking.service';
import { ProfessionalsHomeService } from '../professionals/services/professionals-home.service';
import { EnquiryService } from '../commerce/services/enquiry.service';
import { AutoGuideService } from '../intelligence/services/auto-guide.service';
import { DemandService } from '../intelligence/services/demand.service';
import { MetricsService } from '../intelligence/services/metrics.service';

/** What a member is told when the last of their documents could not be accepted (§2.9). */
const INFECTED_DOCUMENT_MESSAGE =
  "One of your documents couldn't be accepted. Please upload it again.";

/** How many rows one rescan pass re-queues, so a long outage does not flood the queue. */
const RESCAN_BATCH = 200;

/** The scheduled work that keeps the platform's promises true between requests. */
@Injectable()
export class PlatformJobsService {
  private readonly logger = new Logger(PlatformJobsService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly database: PrismaService,
    private readonly media: MediaUploadService,
    private readonly derivation: MediaDerivationService,
    private readonly searchDemand: SearchDemandService,
    private readonly bookings: BookingService,
    private readonly enquiries: EnquiryService,
    private readonly professionals: ProfessionalsHomeService,
    private readonly demand: DemandService,
    private readonly autoGuides: AutoGuideService,
    private readonly metrics: MetricsService,
    private readonly classifier: SafetyClassifierService,
    private readonly safetyQueue: ContentSafetyQueue,
    private readonly safety: ContentSafetyService,
    private readonly storage: StorageProvider,
    private readonly dataExports: DataExportBuilderService,
    private readonly notifications: NotificationFeedService,
  ) {}

  /** A booking auto-completes 7 days after delivery (2.9.5). */
  @Cron(CronExpression.EVERY_HOUR, { name: 'bookings.auto-complete' })
  async autoCompleteBookings(context: JobRunContext = CRON_RUN) {
    await this.run(
      'bookings.auto-complete',
      async () => {
        const closed = await this.bookings.runAutoComplete();

        return closed ? `closed ${closed} delivered bookings` : null;
      },
      context,
    );
  }

  /** D24: an enquiry nobody confirms goes stale after 30 days. */
  @Cron(CronExpression.EVERY_HOUR, { name: 'enquiries.expire' })
  async expireEnquiries(context: JobRunContext = CRON_RUN) {
    await this.run(
      'enquiries.expire',
      async () => {
        const expired = await this.enquiries.runExpiry();

        return expired ? `expired ${expired} stale enquiries` : null;
      },
      context,
    );
  }

  /** Requests with a `neededOn` that has passed are no longer open questions. */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'requests.expire' })
  async expireRequests(context: JobRunContext = CRON_RUN) {
    await this.run(
      'requests.expire',
      async () => {
        const cutoff = new Date();

        cutoff.setUTCHours(0, 0, 0, 0);

        const result = await this.database.communityRequest.updateMany({
          where: { status: 'OPEN', deletedAt: null, neededOn: { lt: cutoff } },
          data: { status: 'EXPIRED' },
        });

        return result.count ? `expired ${result.count} past-dated requests` : null;
      },
      context,
    );
  }

  /**
   * Reads width, height and duration out of anything uploaded since the last pass (0.11.4).
   * `attach` covers the common case; only the sweep visits media uploaded but never attached.
   */
  @Cron(CronExpression.EVERY_30_MINUTES, { name: 'media.derive' })
  async deriveMedia(context: JobRunContext = CRON_RUN) {
    await this.run(
      'media.derive',
      async () => {
        const derived = await this.derivation.sweep();

        return derived ? `read ${derived} object header(s)` : null;
      },
      context,
    );
  }

  /** Orphan media is deleted after 24 hours if never attached to a post (0.11). */
  @Cron(CronExpression.EVERY_HOUR, { name: 'media.sweep-orphans' })
  async sweepOrphanMedia(context: JobRunContext = CRON_RUN) {
    await this.run(
      'media.sweep-orphans',
      async () => {
        const swept = await this.media.sweepOrphans();

        return swept ? `removed ${swept} orphaned uploads` : null;
      },
      context,
    );
  }

  /**
   * A document that turned out to be infected after the submission was accepted (§2.9).
   *
   * A scan may still be running when a member submits — refusing the submission until it finishes
   * would make them wait on a queue they cannot see. So the file is accepted, and if the verdict
   * comes back INFECTED this takes it out.
   *
   * If that leaves the listing with none, the listing is **rejected with a message the member can
   * act on**. Leaving it PENDING would be worse: it would sit in the review queue for a reviewer
   * who has nothing to read, and the member would be waiting on a decision nobody can take.
   */
  @Cron(CronExpression.EVERY_30_MINUTES, { name: 'listings.infected-documents' })
  async removeInfectedDocuments(context: JobRunContext = CRON_RUN) {
    await this.run(
      'listings.infected-documents',
      async () => {
        const infected = await this.database.media.findMany({
          where: {
            ownerType: LISTING_DOCUMENT_OWNER,
            supersededAt: null,
            scanStatus: MediaScanStatus.INFECTED,
          },
          select: { id: true, ownerId: true },
          take: 200,
        });

        if (!infected.length) return null;

        const listingIds = [...new Set(infected.map(row => row.ownerId as string))];

        await this.database.media.updateMany({
          where: { id: { in: infected.map(row => row.id) } },
          data: { supersededAt: new Date() },
        });

        let rejected = 0;

        for (const listingId of listingIds) {
          const left = await this.database.media.count({
            where: { ownerType: LISTING_DOCUMENT_OWNER, ownerId: listingId, supersededAt: null },
          });

          if (left > 0) continue;

          // visibility: a job reading the listing whose documents it has just removed, to decide
          // whether anything is left to review. No reader is being served, so no filter applies.
          const listing = await this.database.professionalListing.findUnique({
            where: { id: listingId },
            select: { id: true, userId: true, reviewState: true },
          });

          // Only one that is still waiting. A listing already approved keeps its approval: the
          // decision was taken on documents a reviewer read, and one of them failing a scan
          // afterwards is not grounds to undo it silently.
          if (!listing || listing.reviewState !== ListingReviewState.PENDING) continue;

          await this.database.$transaction(async tx => {
            await tx.professionalListing.update({
              where: { id: listing.id },
              data: {
                reviewState: ListingReviewState.REJECTED,
                reviewDecidedAt: new Date(),
                reviewNote: INFECTED_DOCUMENT_MESSAGE,
              },
            });

            await this.safety.applyDecision(tx, {
              targetType: ReportTargetType.PROFESSIONAL_LISTING,
              targetId: listing.id,
              state: ContentVisibilityState.REJECTED,
              decision: ModerationDecision.REJECT,
              // No staff member decided this; the scanner did. Recorded as the subject's own listing
              // rather than crediting a reviewer who never saw it.
              reviewerId: listing.userId,
            });

            await tx.moderationQueueItem.updateMany({
              where: {
                type: ModerationQueueType.PROFESSIONAL_REVIEW,
                targetId: listing.id,
                state: { not: ModerationQueueState.RESOLVED },
              },
              data: {
                state: ModerationQueueState.RESOLVED,
                decision: ModerationDecision.REJECT,
                decisionNote: 'Documents could not be accepted.',
                decidedAt: new Date(),
              },
            });
          });

          this.notifications.raise({
            userId: listing.userId,
            kind: NotificationKind.MODERATION,
            categoryCode: 'ACCOUNT',
            title: 'We couldn’t accept one of your documents',
            body: 'Please upload it again.',
            // The form, not the listing: this row exists because the member has to re-upload, and
            // the listing view has no documents step to do it from.
            route: LISTING_ROUTE.edit,
          });

          rejected += 1;
        }

        return `removed ${infected.length} infected document(s)${
          rejected ? `, rejected ${rejected} listing(s)` : ''
        }`;
      },
      context,
    );
  }

  /**
   * Superseded supporting documents, ninety days on (§2.9 retention).
   *
   * Kept that long so an appeal about a decision can be about the evidence the decision was taken
   * on. After that the platform has no reason to hold somebody's certificates, and holding them
   * anyway is the difference between a retention policy and a filing cabinet.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'retention.purge-documents' })
  async purgeSupersededDocuments(context: JobRunContext = CRON_RUN) {
    await this.run(
      'retention.purge-documents',
      async () => {
        const cutoff = new Date(Date.now() - DOCUMENT_RETENTION_DAYS * 86_400_000);
        const expired = await this.database.media.findMany({
          where: { ownerType: LISTING_DOCUMENT_OWNER, supersededAt: { lt: cutoff } },
          select: { id: true, storageKey: true },
          take: 500,
        });

        if (!expired.length) return null;

        // Storage first, then the rows: a deleted row with the object still in the bucket is a file
        // nothing points at and nothing will ever clean up.
        await Promise.all(
          expired.map(row => this.storage.delete(row.storageKey).catch(() => undefined)),
        );
        await this.database.media.deleteMany({ where: { id: { in: expired.map(row => row.id) } } });

        return `purged ${expired.length} superseded document(s)`;
      },
      context,
    );
  }

  /** Idempotency records are worthless after their 24-hour window (0.12). */
  /**
   * B16: builds the subject access requests that have been asked for (§13.7).
   *
   * Every five minutes rather than hourly, because a member who taps "download my data" and is
   * told "we will email you" should get the email while they are still holding the phone. The work
   * is a handful of selects and a kilobyte of JSON, so the cost of a pass that finds nothing is
   * one indexed query.
   */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'data-exports.build' })
  async buildDataExports(context: JobRunContext = CRON_RUN): Promise<void> {
    await this.run('data-exports.build', () => this.dataExports.buildPending(), context);
  }

  @Cron(CronExpression.EVERY_6_HOURS, { name: 'idempotency.sweep' })
  async sweepIdempotency(context: JobRunContext = CRON_RUN) {
    await this.run(
      'idempotency.sweep',
      async () => {
        const result = await this.database.idempotencyRecord.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });

        return result.count ? `removed ${result.count} expired idempotency records` : null;
      },
      context,
    );
  }

  /** `medianResponseMinutes` is one definition read by three surfaces: the profile, the dashboard and the maxResponseHours filter (2.11). */
  @Cron(CronExpression.EVERY_DAY_AT_4AM, { name: 'professionals.response-times' })
  async recomputeResponseTimes(context: JobRunContext = CRON_RUN) {
    await this.run(
      'professionals.response-times',
      async () => {
        const updated = await this.professionals.recomputeResponseTimes();

        return updated ? `updated ${updated} listings` : null;
      },
      context,
    );
  }

  /** Circl Intelligence: the demand rollup behind Guided Creation. */
  @Cron(CronExpression.EVERY_2_HOURS, { name: 'intelligence.demand' })
  async rebuildDemand(context: JobRunContext = CRON_RUN) {
    await this.run(
      'intelligence.demand',
      async () => {
        const written = await this.demand.rebuild();

        return written ? `rebuilt ${written} demand signals` : null;
      },
      context,
    );
  }

  /** Circl Intelligence: Auto-Guides. */
  @Cron(CronExpression.EVERY_DAY_AT_2AM, { name: 'intelligence.auto-guides' })
  async draftAutoGuides(context: JobRunContext = CRON_RUN) {
    await this.run(
      'intelligence.auto-guides',
      async () => {
        const { clusters, drafted } = await this.autoGuides.run();

        return drafted ? `drafted ${drafted} guides from ${clusters} question clusters` : null;
      },
      context,
    );
  }

  /** Circl Intelligence: the Pulse dashboards, precomputed per section per city. */
  /**
   * The published search lists (6.3). Daily, and deliberately not per-search: nobody needs this
   * leaderboard to move within the minute, the windows are a week and the week before, and
   * resolving the same typed fragment on every keystroke is work done thousands of times for one
   * answer. Runs before the metrics job so both read the same day.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM, { name: 'intelligence.search-demand' })
  async rebuildSearchDemand(context: JobRunContext = CRON_RUN) {
    await this.run(
      'intelligence.search-demand',
      async () => {
        const written = await this.searchDemand.rebuild();

        return `${written} snapshots`;
      },
      context,
    );
  }

  @Cron(CronExpression.EVERY_DAY_AT_5AM, { name: 'intelligence.metrics' })
  async rebuildMetrics(context: JobRunContext = CRON_RUN) {
    await this.run(
      'intelligence.metrics',
      async () => {
        const monthly = await this.metrics.rebuild('MONTH');
        const weekly = await this.metrics.rebuild('WEEK');

        return `rebuilt ${monthly + weekly} metric snapshots`;
      },
      context,
    );
  }

  /**
   * The classifier's second chance (§6.7).
   *
   * Two jobs in one pass, because they are the same question — content the pipeline did not
   * finish with:
   *
   * - `DEGRADED` rows scanned in the last 24 hours go back on the queue. The lexicon verdict is
   *   standing in for a classifier that was down, and standing in is not the same as deciding: a
   *   post the classifier would have held is in a feed until it is asked again.
   * - `PENDING` rows older than five minutes are rows whose job never arrived (Redis restarted
   *   between the write and the worker). They are the ones sitting in the provisional LIMITED
   *   state, so they are invisible until something finishes them.
   *
   * Ten minutes, as the spec says. It does nothing at all while the classifier is switched off —
   * there is no second opinion to come back for.
   */
  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'safety.rescan-degraded' })
  async rescanDegraded(context: JobRunContext = CRON_RUN) {
    await this.run(
      'safety.rescan-degraded',
      async () => {
        if (!(await this.classifier.enabled())) return null;

        const now = Date.now();
        const rows = await this.database.contentSafety.findMany({
          where: {
            // Only what the worker could actually re-read. A message's row is observe-only and has
            // no source, so re-queueing it would record it degraded again and bring it straight
            // back here on the next pass (§6.8).
            targetType: { in: SCANNABLE_TARGETS },
            OR: [
              {
                scanStatus: ContentScanStatus.DEGRADED,
                updatedAt: { gte: new Date(now - 24 * 3_600_000) },
              },
              {
                scanStatus: ContentScanStatus.PENDING,
                createdAt: { lt: new Date(now - 5 * 60_000) },
              },
            ],
          },
          select: { targetType: true, targetId: true, scanVersion: true, scanStatus: true },
          orderBy: { updatedAt: 'asc' },
          take: RESCAN_BATCH,
        });

        if (!rows.length) return null;

        // A DEGRADED row has already been through the worker, so its version would dedupe against
        // the finished job. Bumping it is what makes the retry a new scan rather than a no-op — and
        // it moves `scanStatus` back to PENDING, which is the state `finalise` will act on.
        for (const row of rows) {
          const next =
            row.scanStatus === ContentScanStatus.DEGRADED ? row.scanVersion + 1 : row.scanVersion;

          if (next !== row.scanVersion) {
            await this.database.contentSafety.update({
              where: {
                targetType_targetId: { targetType: row.targetType, targetId: row.targetId },
              },
              data: { scanVersion: next, scanStatus: ContentScanStatus.PENDING },
            });
          }

          await this.safetyQueue.enqueue({
            targetType: row.targetType,
            targetId: row.targetId,
            scanVersion: next,
            trigger: ContentScanTrigger.RESCAN,
          });
        }

        return `re-queued ${rows.length} scan(s)`;
      },
      context,
    );
  }

  /** Runs one job now, by name. */
  async runNow(name: string, actorId?: string): Promise<string> {
    const jobs: Record<string, (context: JobRunContext) => Promise<void>> = {
      'bookings.auto-complete': context => this.autoCompleteBookings(context),
      'enquiries.expire': context => this.expireEnquiries(context),
      'requests.expire': context => this.expireRequests(context),
      'media.sweep-orphans': context => this.sweepOrphanMedia(context),
      'idempotency.sweep': context => this.sweepIdempotency(context),
      'professionals.response-times': context => this.recomputeResponseTimes(context),
      'intelligence.demand': context => this.rebuildDemand(context),
      'intelligence.auto-guides': context => this.draftAutoGuides(context),
      'intelligence.metrics': context => this.rebuildMetrics(context),
      'intelligence.search-demand': context => this.rebuildSearchDemand(context),
      'safety.rescan-degraded': context => this.rescanDegraded(context),
      'data-exports.build': context => this.buildDataExports(context),
    };

    const job = jobs[name];

    if (!job) {
      throw ApiException.notFound(
        `"${name}" is not a job. One of: ${Object.keys(jobs).sort().join(', ')}.`,
      );
    }

    // The trigger travels with the call, not on the service. Two instance fields were shared by
    // every concurrent run: a cron firing while somebody pressed "run now" was recorded as their
    // manual run, and it re-threw into a scheduler with nobody to tell.
    await job({ trigger: 'MANUAL', actorId: actorId ?? null });

    return name;
  }

  /** One wrapper so every job logs the same way and none can take the others down with it. */
  private async run(
    name: string,
    work: () => Promise<string | null>,
    context: JobRunContext,
  ): Promise<void> {
    // Cron jobs run per instance.
    //
    // No history row for a run that did not happen: on an instance with the schedule switched off
    // this branch is taken by fifteen jobs every few minutes, and a table full of "this instance
    // does not run jobs" is configuration restated thousands of times a day, not history.
    if (
      context.trigger === 'CRON' &&
      this.config.get<string>('DISABLE_SCHEDULED_JOBS') === 'true'
    ) {
      return;
    }

    const started = Date.now();
    const startedAt = new Date();
    const { trigger, actorId } = context;

    try {
      const summary = await work();

      if (summary) {
        this.logger.log(`${name}: ${summary} (${Date.now() - started}ms)`);
      }

      await this.note(name, startedAt, started, trigger, actorId, QueueJobStatus.SUCCESS, {
        summary,
      });
    } catch (error) {
      this.logger.error(`${name} failed: ${(error as Error).message}`, (error as Error).stack);

      await this.note(
        name,
        startedAt,
        started,
        trigger,
        actorId,
        QueueJobStatus.FAILED,
        null,
        (error as Error).message,
      );

      // On the schedule a failure is logged and the next job still runs: one bad job must not take the others down.
      if (context.trigger === 'MANUAL') {
        throw ApiException.conflict(
          ApiErrorCode.JOB_FAILED,
          `${name} ran and failed: ${(error as Error).message}`,
          { data: { job: name } },
        );
      }
    }
  }

  /**
   * One `QueueJobLog` row per run (§4.11, B19).
   *
   * The table existed and nothing wrote to it, so "when did the media derivation last run, and did
   * it work" was a question only a log search could answer — and only as far back as the log
   * retention. A row is cheap and it is the thing §5.22's run list reads.
   *
   * Written **after** the work rather than around it, because this is the synchronous runner: a
   * row claiming `RUNNING` would never be corrected if the process died mid-job. When §5.22 moves
   * the manual run onto a queue, the enqueue writes the row and the worker closes it, and that is
   * the point at which a `RUNNING` status earns its place.
   *
   * It never throws. A job that did its work and could not write its own history row has still
   * done its work, and failing the run — or worse, turning a success into a logged failure —
   * because the bookkeeping failed would be the wrong way round.
   */
  private async note(
    name: string,
    startedAt: Date,
    startedMs: number,
    trigger: string,
    actorId: string | null,
    status: QueueJobStatus,
    metadata: Record<string, unknown> | null,
    error?: string,
  ): Promise<void> {
    try {
      await this.database.queueJobLog.create({
        data: {
          queueName: 'platform-jobs',
          operation: name,
          status,
          trigger,
          userId: actorId,
          startedAt,
          durationMs: Date.now() - startedMs,
          // Truncated: a stack trace or a database error listing a thousand ids is not a history
          // entry, and the full text is in the log line above with its correlation id.
          error: error ? error.slice(0, 1000) : null,
          metadata: metadata && metadata.summary ? (metadata as Prisma.InputJsonValue) : undefined,
        },
      });
    } catch (failure) {
      this.logger.warn(`${name}: run not recorded — ${(failure as Error).message}`);
    }
  }
}
