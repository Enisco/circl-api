import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

/** The queue §5.18 names. Registered by `AdminModule`, so a member-only process has no worker. */
export const ANNOUNCEMENTS_QUEUE = 'announcements';

export interface AnnouncementJob {
  announcementId: string;
}

/**
 * Three attempts, because a fan-out that stops halfway is worse than one that starts twice.
 *
 * Starting twice is safe: the delivery row's primary key is `(announcement, member, channel)` and
 * the worker writes it before attempting, so a resumed run skips everybody it already reached.
 */
const ATTEMPTS = 3;

/** Five minutes out at the earliest, so a schedule can still be cancelled after it is set. */
export const MIN_SCHEDULE_MINUTES = 5;

/** Ninety days at the outside. Further than that is a reminder nobody will remember setting. */
export const MAX_SCHEDULE_DAYS = 90;

@Injectable()
export class AnnouncementQueue {
  private readonly logger = new Logger(AnnouncementQueue.name);

  constructor(@InjectQueue(ANNOUNCEMENTS_QUEUE) private readonly queue: Queue<AnnouncementJob>) {}

  /**
   * Queues a fan-out, now or at a time.
   *
   * `jobId` is the announcement's own id, so a double-pressed send cannot start two fan-outs over
   * one audience — BullMQ drops the duplicate. A scheduled job is a **delayed** job rather than a
   * row a cron sweeps, as §5.18 prefers: the delay is the scheduler, so nothing has to ask every
   * minute whether anything is due.
   */
  async enqueue(announcementId: string, when?: Date): Promise<void> {
    const delay = when ? Math.max(0, when.getTime() - Date.now()) : 0;

    try {
      await this.queue.add(
        'fan-out',
        { announcementId },
        {
          jobId: announcementId,
          delay,
          attempts: ATTEMPTS,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: true,
          // Kept: a fan-out that failed is something somebody will ask about, and the row alone
          // cannot say which attempt threw what.
          removeOnFail: false,
        },
      );
    } catch (error) {
      // Thrown rather than swallowed, unlike the export queue: an export that never runs leaves a
      // visible QUEUED row a staff member can retry, while an announcement left SENDING with no
      // worker behind it reads as "going out now" forever.
      this.logger.error(
        `Could not queue announcement ${announcementId}: ${(error as Error).message}`,
      );

      throw error;
    }
  }

  /** Drops a delayed job, for a schedule somebody cancelled before it fired. */
  async cancel(announcementId: string): Promise<void> {
    try {
      const job = await this.queue.getJob(announcementId);

      await job?.remove();
    } catch (error) {
      // Not fatal: the worker re-reads the row and stops on a cancelled one anyway, so a job left
      // in the queue wakes, finds CANCELLED and exits. This is tidiness; the state is the control.
      this.logger.warn(
        `Could not remove the queued job for ${announcementId}: ${(error as Error).message}`,
      );
    }
  }
}
