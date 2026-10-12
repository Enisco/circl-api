import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ADMIN_EXPORTS_QUEUE, AdminExportJob } from './admin-export.queue';
import { AdminExportRunner } from './admin-export-runner.service';

/**
 * Builds the CSVs (§5.26).
 *
 * In the admin process rather than a generic worker, which is the boundary §2 draws: an export
 * reads member data under a staff member's permissions, and the member API has no business being
 * able to produce one.
 */
@Injectable()
@Processor(ADMIN_EXPORTS_QUEUE)
export class AdminExportProcessor extends WorkerHost {
  private readonly logger = new Logger(AdminExportProcessor.name);

  constructor(private readonly runner: AdminExportRunner) {
    super();
  }

  async process(job: Job<AdminExportJob>): Promise<void> {
    const attempts = job.opts.attempts ?? 1;
    // The row is marked FAILED only when no attempt is left. Writing it on the first failure would
    // show a staff member a failed export that is in fact about to be retried and succeed.
    const lastAttempt = job.attemptsMade + 1 >= attempts;

    try {
      await this.runner.run(job.data.exportId, { lastAttempt });
    } catch (error) {
      this.logger.error(
        `Export ${job.data.exportId} failed on attempt ${job.attemptsMade + 1}/${attempts}: ${(error as Error).message}`,
      );

      throw error;
    }
  }
}
