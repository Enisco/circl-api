import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ANNOUNCEMENTS_QUEUE, AnnouncementJob } from './announcement.queue';
import { AnnouncementFanoutService } from './announcement-fanout.service';

/**
 * Runs the fan-out (§5.18).
 *
 * In the admin process, like the export worker and for the same reason: an announcement is sent
 * under a staff member's authority, and the member API has no business being able to start one.
 */
@Injectable()
@Processor(ANNOUNCEMENTS_QUEUE)
export class AnnouncementProcessor extends WorkerHost {
  private readonly logger = new Logger(AnnouncementProcessor.name);

  constructor(private readonly fanout: AnnouncementFanoutService) {
    super();
  }

  async process(job: Job<AnnouncementJob>): Promise<void> {
    const attempts = job.opts.attempts ?? 1;
    // Which attempt this is, passed down rather than guessed: the fan-out leaves the row `SENDING`
    // on a middle attempt and only writes `FAILED` on the last, because a row marked failed is one
    // the next attempt refuses to pick up.
    const last = job.attemptsMade + 1 >= attempts;

    try {
      await this.fanout.run(job.data.announcementId, { last });
    } catch (error) {
      this.logger.error(
        `Announcement ${job.data.announcementId} failed on attempt ${job.attemptsMade + 1}/${attempts}: ${(error as Error).message}`,
      );

      // Re-thrown so BullMQ retries. A retry **resumes**: the delivery rows are written before
      // each attempt, so whoever already has it is skipped rather than sent to twice.
      throw error;
    }
  }
}
