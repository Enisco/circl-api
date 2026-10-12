import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ContentScanTrigger, ReportTargetType } from '@prisma/client';
import { Queue } from 'bullmq';

/** §6.2 names it. */
export const CONTENT_SAFETY_QUEUE = 'content-safety';

export interface ContentSafetyJob {
  targetType: ReportTargetType;
  targetId: string;
  /** The version the inline scan wrote. A job carrying an older one is stale and does nothing. */
  scanVersion: number;
  trigger: ContentScanTrigger;
}

/** §6.7: three attempts at 1s, 4s and 15s, then the lexicon verdict stands as DEGRADED. */
const ATTEMPTS = 3;

/**
 * Half a second, because the job is queued **inside** the write transaction.
 *
 * Enqueueing after the commit would mean a post that is committed and never queued if the process
 * dies in between — the one ordering that loses work silently. Queued inside, the risk is the
 * opposite and recoverable: the worker may arrive before the commit, see no row or an older
 * version, and retry. The delay makes that rare and the retry makes it harmless.
 */
const COMMIT_GRACE_MS = 500;

@Injectable()
export class ContentSafetyQueue {
  private readonly logger = new Logger(ContentSafetyQueue.name);

  constructor(@InjectQueue(CONTENT_SAFETY_QUEUE) private readonly queue: Queue<ContentSafetyJob>) {}

  /**
   * One job per `(target, version)`, which is §6.2's own dedupe rule: two writes of the same
   * version are the same scan, and BullMQ drops the second.
   *
   * Dashes, not the colons §6.2 writes the id with. BullMQ reserves `:` for its own key shapes and
   * refuses most ids that contain one -- `a:b` and `message:abc` are both rejected outright, while
   * `REQUEST:abc:1` is accepted because it ends in a number and so reads as a scheduler key. The
   * spec's spelling therefore worked here by luck of the trailing version and failed on the message
   * queue, which has no trailing number. No colons at all is the only version of this that is not
   * an accident.
   */
  async enqueue(job: ContentSafetyJob): Promise<void> {
    try {
      await this.queue.add('classify', job, {
        jobId: `${job.targetType}-${job.targetId}-v${job.scanVersion}`,
        attempts: ATTEMPTS,
        backoff: { type: 'exponential', delay: 1_000 },
        delay: COMMIT_GRACE_MS,
        removeOnComplete: true,
        removeOnFail: false,
      });
    } catch (error) {
      // A queue that is down is §6.7's "Redis down" row: the content keeps its inline verdict and
      // `safety.rescan-degraded` sweeps the provisional ones. Loud, because nothing else notices.
      this.logger.error(
        `Could not queue a scan for ${job.targetType} ${job.targetId}: ${(error as Error).message}`,
      );
    }
  }
}
