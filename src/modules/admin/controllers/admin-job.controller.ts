import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminJwtGuard } from '@/common/guards/admin-jwt.guard';
import { AdminPageOptionsDto, CurrentUser, RateLimit, SuccessMessage } from '@/common';
import { AdminBffGuard } from '../common/admin-bff.guard';
import { AdminPermissionGuard } from '../common/admin-permission.guard';
import { AdminPermissions, AdminPrincipal } from '../common/admin-principal';
import { AuditService } from '../audit/audit.service';
import { AdminJobRunnerService } from '../jobs/admin-job-runner.service';
import { AdminJobReadService } from '../services/admin-job-read.service';

/**
 * §5.22: the scheduled jobs, and what they have done.
 *
 * The run endpoint moved here from `AdminController` so that jobs are one place rather than three
 * — the path is unchanged. Reading is `config:read` and running is `jobs:run`, which only super
 * admins hold: the two are a different kind of act and §4.13 separates them.
 *
 * `POST :name/run` is still **synchronous**, which §5.22 changes to an enqueue returning `202`
 * with a run id. That rewrite needs a queue the member process consumes, because the jobs it runs
 * live there; the run log and this history are the half of it that could be built first, and are
 * what the async version would poll. Until then a long job holds its request open, and the
 * endpoint says so.
 */
@ApiExcludeController()
@ApiTags('Admin · Jobs')
@Controller('admin/jobs')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminJobController {
  constructor(
    private readonly jobs: AdminJobRunnerService,
    private readonly reads: AdminJobReadService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @AdminPermissions('config:read')
  @ApiOperation({
    summary: 'Every scheduled job',
    description:
      'From the declared catalogue rather than from this process’s scheduler, so the list is the ' +
      'same wherever the portal is pointed. `disabledOnThisInstance` is true where the job is ' +
      'not scheduled **here** — an admin-only deployment runs its own three and none of the ' +
      'product sections’ — and `nextRunAt` is null for those, because this process does not know ' +
      'when another one will fire.',
  })
  async list() {
    return {
      data: await this.reads.list(),
      message: SuccessMessage.RESOURCE_FETCHED('Jobs'),
    };
  }

  @Get(':name/runs')
  @AdminPermissions('config:read')
  @ApiOperation({
    summary: 'One job’s history',
    description:
      'Newest first. One row per run, written by the wrapper every job goes through — including ' +
      'the failures, with the error message truncated to a thousand characters. Nothing is ' +
      'written for a run the schedule skipped because jobs are switched off on that instance: ' +
      'that is configuration, not history.',
  })
  async runs(@Param('name') name: string, @Query() query: AdminPageOptionsDto) {
    const result = await this.reads.runs(name, query);

    return { ...result, message: SuccessMessage.RESOURCE_FETCHED('Job runs') };
  }

  @Post(':name/run')
  @AdminPermissions('jobs:run')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'Run a scheduled job now',
    description:
      'The cron decorators are the schedule; this is the switch. Runs **synchronously** and ' +
      'returns when the job has finished, so a long one can outlast the request — §5.22 replaces ' +
      'this with an enqueue and a `202`. Answers `409` on a process that does not run jobs at ' +
      'all, and the run is recorded in `:name/runs` either way.',
  })
  async run(@CurrentUser() actor: AdminPrincipal, @Param('name') name: string) {
    /**
     * Audited either way (§5.22).
     *
     * `job.run` was in the action registry and nothing wrote it, so running a job by hand left no
     * trace at all. Then it was written only after a *successful* run — and a failed one is the
     * one somebody asks about afterwards, so the trail skipped exactly the runs worth recording.
     * The outcome is in the entry rather than in whether there is one.
     */
    const noted = (outcome: 'SUCCESS' | 'FAILED', error?: string) =>
      this.audit.note({
        action: 'job.run',
        targetType: 'JOB',
        targetId: name,
        targetLabel: name,
        metadata: { trigger: 'MANUAL', outcome, ...(error ? { error } : {}) },
      });

    let ran: string;

    try {
      ran = await this.jobs.run(name, actor.id);
    } catch (error) {
      await noted('FAILED', (error as Error).message.slice(0, 500));

      throw error;
    }

    await noted('SUCCESS');

    return { data: { job: ran }, message: `Ran ${ran}` };
  }
}
