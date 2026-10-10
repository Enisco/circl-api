/**
 * The scheduled-work surface. Narrow on purpose: running a job on demand is the only thing another
 * module has any business doing here.
 */
export { PlatformJobsModule } from './jobs.module';
export { PlatformJobsService } from './platform-jobs.service';
