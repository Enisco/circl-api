import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ApiErrorCode, ApiException } from '@/common';
import { PlatformJobsService } from '@/modules/platform/jobs';
import { AdminJobsService } from './admin-jobs.service';

/**
 * Runs a scheduled job on demand, without the admin API depending on the job runner.
 *
 * The job runner schedules every product section's work — bookings, enquiries, media derivation,
 * the metrics rollups — so importing its module pulls in most of the member API. That would make
 * `APP_SURFACE=admin` a process serving every member route, which is the opposite of the point.
 *
 * So the class is used as a lookup token rather than an import: resolved from the container at
 * call time, present in a combined process and absent in an admin-only one. The dependency is on a
 * name, not on a module graph.
 *
 * This is a bridge, and the spec already describes what replaces it (§5.22, B19): the endpoint
 * should enqueue the request and return a run-log entry rather than execute inside the HTTP
 * request. That design has no in-process dependency at all — which is the real fix, and it arrives
 * with the configuration milestone.
 */
@Injectable()
export class AdminJobRunnerService {
  private readonly logger = new Logger(AdminJobRunnerService.name);

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly adminJobs: AdminJobsService,
  ) {}

  async run(name: string): Promise<string> {
    // The admin surface's own jobs first: they are in this process whatever the deployment, and
    // the lookup below cannot find them because they are not registered with the platform runner.
    if (await this.adminJobs.runNow(name)) return name;

    const jobs = this.resolve();

    if (!jobs) {
      this.logger.warn({ job: name, reason: 'job_runner_not_in_this_process' });

      throw ApiException.conflict(
        ApiErrorCode.NOT_AVAILABLE_YET,
        'This process does not run scheduled jobs. Ask the worker deployment, or wait for the ' +
          'queued run that replaces this endpoint.',
      );
    }

    return jobs.runNow(name);
  }

  /** Whether this process can run jobs at all, so the portal can hide the button. */
  available(): boolean {
    return this.resolve() !== null;
  }

  private resolve(): PlatformJobsService | null {
    try {
      // `strict: false` searches the whole container rather than this module's own providers,
      // which is what lets the lookup succeed without an import.
      return this.moduleRef.get(PlatformJobsService, { strict: false });
    } catch {
      return null;
    }
  }
}
