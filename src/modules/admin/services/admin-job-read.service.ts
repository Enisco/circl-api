import { Injectable } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { QueueJobStatus } from '@prisma/client';
import { AdminPageOptionsDto, ApiException, buildPageMeta } from '@/common';
import { PrismaService } from '@/infrastructure';
import { MediaService } from '@/modules/platform/shared';
import { JOB_CATALOGUE, jobDefinition } from '@/modules/platform/jobs';
import { StaffRefView, staffRefSelect, toStaffRef } from '../serializers/admin-staff.serializer';
import { AdminJobRunnerService } from '../jobs/admin-job-runner.service';

export interface JobRunView {
  id: string;
  name: string;
  trigger: 'CRON' | 'MANUAL' | null;
  triggeredBy: StaffRefView | null;
  status: QueueJobStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  summary: string | null;
  error: string | null;
}

export interface JobView {
  name: string;
  schedule: string;
  description: string;
  lastRun: JobRunView | null;
  nextRunAt: string | null;
  disabledOnThisInstance: boolean;
  canRunNow: boolean;
}

/**
 * §5.22's two reads: what the jobs are, and what they have done.
 *
 * The run history is the half B19 made possible — `QueueJobLog` existed and nothing wrote to it, so
 * "when did this last run, and did it work" was a question only a log search could answer, and only
 * as far back as the log retention. Every run now writes a row; this is what reads them.
 *
 * The list comes from the **catalogue** rather than from `SchedulerRegistry`, because the registry
 * only knows what is registered in this process and the admin surface does not schedule the
 * platform's work. The registry is still used for the one thing only it knows — when the job next
 * fires here — and its absence is what `disabledOnThisInstance` reports.
 */
@Injectable()
export class AdminJobReadService {
  constructor(
    private readonly database: PrismaService,
    private readonly media: MediaService,
    private readonly scheduler: SchedulerRegistry,
    private readonly runner: AdminJobRunnerService,
  ) {}

  async list(): Promise<JobView[]> {
    // One query for every job's latest run rather than one per job: eighteen round trips to draw a
    // table is the kind of thing that is fine in development and visible in production.
    const latest = await this.database.queueJobLog.findMany({
      where: { operation: { in: JOB_CATALOGUE.map(job => job.name) } },
      orderBy: [{ operation: 'asc' }, { createdAt: 'desc' }],
      distinct: ['operation'],
    });
    const staff = await this.staffFor(latest.map(row => row.userId));
    const byName = new Map(latest.map(row => [row.operation, row]));
    // Present in this process, which is what decides whether the schedule is actually running.
    const live = this.registeredNames();
    // A platform job can only be run on demand where the platform runner is in this process.
    const runnerHere = this.runner.available();

    return JOB_CATALOGUE.map(job => {
      const run = byName.get(job.name);
      const scheduledHere = live.has(job.name);

      return {
        name: job.name,
        schedule: job.schedule,
        description: job.description,
        lastRun: run ? this.toRun(run, staff) : null,
        nextRunAt: scheduledHere ? this.nextRunAt(job.name) : null,
        // Not "switched off" — unavailable **here**. A combined deployment runs everything; an
        // admin-only one runs its own three and reports the rest honestly rather than offering a
        // Run now that answers 409.
        disabledOnThisInstance: !scheduledHere,
        canRunNow: job.onDemand && (job.surface === 'admin' || runnerHere),
      };
    });
  }

  /** One job's runs, newest first (§5.22). */
  async runs(name: string, dto: AdminPageOptionsDto) {
    dto.assertDepth();

    if (!jobDefinition(name)) {
      throw ApiException.notFound(`"${name}" is not a job.`);
    }

    const where = { operation: name };
    const [total, rows] = await this.database.$transaction([
      this.database.queueJobLog.count({ where }),
      this.database.queueJobLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (dto.currentPage - 1) * dto.size,
        take: dto.size,
      }),
    ]);

    const staff = await this.staffFor(rows.map(row => row.userId));

    return {
      data: rows.map(row => this.toRun(row, staff)),
      meta: buildPageMeta({ currentPage: dto.currentPage, perPage: dto.size }, total),
    };
  }

  /**
   * The names Nest has actually scheduled in this process.
   *
   * Wrapped because `getCronJobs()` throws rather than returning empty when no scheduler has been
   * set up at all, and a configuration screen must not 500 because a deployment runs no jobs.
   */
  private registeredNames(): Set<string> {
    try {
      return new Set(this.scheduler.getCronJobs().keys());
    } catch {
      return new Set();
    }
  }

  private nextRunAt(name: string): string | null {
    try {
      const job = this.scheduler.getCronJob(name);
      const next = job.nextDate();

      // `nextDate()` is a Luxon `DateTime` in the versions that have it and a `Date` in the
      // others. Both answer `toISO`/`toISOString`, and neither is worth a dependency to narrow.
      const iso = (next as unknown as { toISO?: () => string }).toISO?.();

      return iso ?? (next as unknown as Date).toISOString();
    } catch {
      return null;
    }
  }

  private async staffFor(ids: Array<string | null>) {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];

    if (!unique.length) return new Map<string, StaffRefView>();

    const rows = await this.database.user.findMany({
      where: { id: { in: unique } },
      select: staffRefSelect,
    });

    return new Map(rows.map(person => [person.id, toStaffRef(person, this.media.sign)]));
  }

  private toRun(
    row: {
      id: string;
      operation: string;
      trigger: string | null;
      userId: string | null;
      status: QueueJobStatus;
      startedAt: Date;
      createdAt: Date;
      durationMs: number | null;
      metadata: unknown;
      error: string | null;
    },
    staff: Map<string, StaffRefView>,
  ): JobRunView {
    const metadata = (row.metadata ?? null) as { summary?: string } | null;

    return {
      id: row.id,
      name: row.operation,
      trigger: (row.trigger as JobRunView['trigger']) ?? null,
      triggeredBy: row.userId ? (staff.get(row.userId) ?? null) : null,
      status: row.status,
      startedAt: row.startedAt.toISOString(),
      // The row is written when the run ends, so `createdAt` **is** the finish. Published under
      // its own name rather than leaving the portal to infer it from `startedAt + durationMs`,
      // which would be a second arithmetic on a number this already carries.
      finishedAt: row.createdAt.toISOString(),
      durationMs: row.durationMs,
      summary: typeof metadata?.summary === 'string' ? metadata.summary : null,
      error: row.error,
    };
  }
}
