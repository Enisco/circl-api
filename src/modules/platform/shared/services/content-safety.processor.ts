import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { CONTENT_SAFETY_QUEUE, ContentSafetyJob } from './content-safety.queue';
import { ContentSafetyService } from './content-safety.service';

/**
 * The classifier half (§6.2 steps 5–8).
 *
 * In the platform process rather than a worker deployment of its own, because the queue it reads
 * is the one the write paths fill and the verdict it applies is the one the read paths honour. A
 * separate deployment would be a second place to configure the same thing.
 */
@Injectable()
@Processor(CONTENT_SAFETY_QUEUE)
export class ContentSafetyProcessor extends WorkerHost {
  private readonly logger = new Logger(ContentSafetyProcessor.name);

  constructor(private readonly safety: ContentSafetyService) {
    super();
  }

  async process(job: Job<ContentSafetyJob>): Promise<void> {
    const attempts = job.opts.attempts ?? 1;
    const lastAttempt = job.attemptsMade + 1 >= attempts;
    const outcome = await this.safety.finalise(job.data, { lastAttempt });

    // `pending` is the one that has to throw: the row is not there yet, or it is older than this
    // job, which means the write transaction has not committed. Throwing is what gets the backoff.
    if (outcome === 'pending') {
      throw new Error(
        `${job.data.targetType} ${job.data.targetId} v${job.data.scanVersion} is not committed yet`,
      );
    }

    if (outcome === 'stale') {
      this.logger.debug(
        `Dropped a stale scan for ${job.data.targetType} ${job.data.targetId} v${job.data.scanVersion}`,
      );
    }
  }
}
