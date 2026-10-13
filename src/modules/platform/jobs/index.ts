/**
 * The scheduled-work surface. Narrow on purpose: running a job on demand is the only thing another
 * module has any business doing here.
 */
export { PlatformJobsModule } from './jobs.module';
export { PlatformJobsService } from './platform-jobs.service';
/**
 * The catalogue, for §5.22's list. Constants rather than a provider, deliberately: the admin
 * surface must be able to describe every job without importing the module that schedules them.
 */
export { JOB_CATALOGUE, JOB_QUEUES, jobDefinition } from './job-catalogue';
export type { JobDefinition } from './job-catalogue';
