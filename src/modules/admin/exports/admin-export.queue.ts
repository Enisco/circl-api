import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

/** The queue §5.26 names. Registered by `AdminModule`, so a member-only process has no worker. */
export const ADMIN_EXPORTS_QUEUE = 'admin-exports';

export interface AdminExportJob {
  exportId: string;
}

/** Three attempts with exponential backoff: a transient S3 or database fault should not cost a staff member their export. */
const ATTEMPTS = 3;

@Injectable()
export class AdminExportQueue {
  private readonly logger = new Logger(AdminExportQueue.name);

  constructor(@InjectQueue(ADMIN_EXPORTS_QUEUE) private readonly queue: Queue<AdminExportJob>) {}

  /**
   * Queues one export.
   *
   * `jobId` is the export's own id, so a double-submitted request cannot produce two files for one
   * row — BullMQ drops the duplicate. Failures are kept (`removeOnFail`) because a failed export
   * is something a staff member will ask about.
   */
  async enqueue(exportId: string): Promise<void> {
    try {
      await this.queue.add(
        'build-export',
        { exportId },
        {
          jobId: exportId,
          attempts: ATTEMPTS,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    } catch (error) {
      // The row is already written and says QUEUED, so a queue that is down leaves a visible
      // export that never completes rather than a request that looked like it failed. Loud,
      // because nothing else will notice.
      this.logger.error(`Could not queue export ${exportId}: ${(error as Error).message}`);
    }
  }
}
