/**
 * Who asked for a job run, carried **per call** rather than kept on the service.
 *
 * It was a pair of instance fields, set before the call and cleared after. Two runs at once —
 * which is exactly what happens when a nightly cron fires while somebody is pressing "run now" —
 * shared them: the cron's run was recorded as `MANUAL` against the staff member who pressed the
 * button, and it re-threw into a scheduler that has nobody to tell. A parameter cannot be shared.
 */
export interface JobRunContext {
  trigger: 'CRON' | 'MANUAL';
  /** The staff member who pressed it. Null on the schedule, which nobody asked for. */
  actorId: string | null;
}

/** The default: a run nobody asked for, which is every scheduled one. */
export const CRON_RUN: JobRunContext = { trigger: 'CRON', actorId: null };

/**
 * A job failure that still has something to report.
 *
 * `audit.verify-chain` seals the trail and *then* checks the seals, so a run that sealed four
 * stretches and found a difference in a fifth has done real work worth recording. Thrown as this
 * rather than a plain `Error`, the work survives into the run's history row beside the error
 * instead of being replaced by it.
 */
export class JobFailure extends Error {
  constructor(
    message: string,
    readonly summary: string | null = null,
  ) {
    super(message);
    this.name = 'JobFailure';
  }
}
