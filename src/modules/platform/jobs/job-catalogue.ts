import { CronExpression } from '@nestjs/schedule';

/**
 * Every scheduled job on the platform, declared once (§5.22).
 *
 * A declared list rather than a reading of Nest's `SchedulerRegistry`, and that is the whole point:
 * the registry only knows the jobs registered **in this process**. `APP_SURFACE=admin` deliberately
 * does not import `PlatformJobsModule` — it schedules every product section's work and would drag
 * most of the member API onto the staff host — so a registry-only list would show three jobs on the
 * admin deployment and eighteen on the combined one, and a portal screen that silently loses
 * fifteen rows depending on where it is pointed is worse than one that shows them as unavailable.
 *
 * So the catalogue is the contract and the registry fills in what only it knows: whether the job is
 * live here, and when it next runs. `description` exists only here — neither the registry nor the
 * on-demand table has anywhere to put one, and "what does `listings.infected-documents` actually
 * do" is the question a configuration screen exists to answer.
 *
 * Kept beside the services it describes so that adding a `@Cron` and forgetting this file is a
 * one-directory mistake rather than a cross-module one. `job-catalogue.spec.ts` holds the two
 * against each other, so forgetting is a failing test rather than a job nobody can see.
 */
export interface JobDefinition {
  /** The `@Cron` name, which is also what `POST admin/jobs/:name/run` takes. */
  name: string;
  /**
   * The cron expression, taken **from `CronExpression`** rather than written out.
   *
   * The first version held hand-written strings and `job-catalogue.spec.ts` caught them being
   * wrong on the first run: `EVERY_HOUR` is `0 0-23/1 * * *`, not `0 0 * * * *`. Both are hourly
   * and only one is what the scheduler is actually using, and a configuration screen that tells
   * somebody the wrong schedule is worse than one that tells them nothing. Referencing the enum
   * removes the second copy instead of correcting it.
   */
  schedule: string;
  description: string;
  /**
   * Which process runs it.
   *
   * `admin` jobs are in the admin module and therefore present on every surface. `platform` jobs
   * are in `PlatformJobsService`, which an admin-only process does not import — those are the ones
   * that come back `disabledOnThisInstance` there.
   */
  surface: 'platform' | 'admin';
  /** Whether `POST admin/jobs/:name/run` accepts it. A few jobs are schedule-only. */
  onDemand: boolean;
}

export const JOB_CATALOGUE: JobDefinition[] = [
  // ─── The admin surface's own (present wherever the portal is) ──────────────
  {
    name: 'enforcement.expire-suspensions',
    schedule: CronExpression.EVERY_5_MINUTES,
    description: 'Lifts suspensions whose end date has passed and restores the account.',
    surface: 'admin',
    onDemand: true,
  },
  {
    name: 'analytics.refresh-member-dimensions',
    schedule: CronExpression.EVERY_10_MINUTES,
    description:
      'Refreshes `mv_member_dimensions`, which every analytics tab and the member list filter on.',
    surface: 'admin',
    onDemand: true,
  },
  {
    name: 'audit.verify-chain',
    schedule: CronExpression.EVERY_DAY_AT_2AM,
    description:
      'Seals the audit trail into hashed segments and recomputes the seals, so a row changed or ' +
      'removed in the database is visible rather than silent (S11.3).',
    surface: 'admin',
    onDemand: true,
  },
  {
    name: 'retention.purge',
    schedule: CronExpression.EVERY_DAY_AT_3AM,
    description:
      '§13.6: deletes what is past its retention — the trail at six years with the chain ' +
      're-anchored, access grants, ended staff sessions, spent invites, year-old announcement ' +
      'deliveries, two-year-old scans and term hits, old report snapshot text, and expired ' +
      'member data-export files.',
    surface: 'admin',
    onDemand: true,
  },
  {
    name: 'exports.expire',
    schedule: CronExpression.EVERY_HOUR,
    description: 'Deletes CSV exports past their seven days and marks the request expired.',
    surface: 'admin',
    onDemand: true,
  },

  // ─── The product sections' (absent on an admin-only process) ───────────────
  {
    name: 'bookings.auto-complete',
    schedule: CronExpression.EVERY_HOUR,
    description: 'Completes bookings the professional marked delivered and nobody disputed.',
    surface: 'platform',
    onDemand: true,
  },
  {
    name: 'enquiries.expire',
    schedule: CronExpression.EVERY_HOUR,
    description: 'Expires shop enquiries nobody answered inside the seller’s window.',
    surface: 'platform',
    onDemand: true,
  },
  {
    name: 'requests.expire',
    schedule: CronExpression.EVERY_DAY_AT_3AM,
    description: 'Closes community requests that have been open past their natural life.',
    surface: 'platform',
    onDemand: true,
  },
  {
    name: 'media.derive',
    schedule: CronExpression.EVERY_30_MINUTES,
    description:
      'Measures and thumbnails uploads the derivation sweep has not reached — width, height, ' +
      'poster frames, durations.',
    surface: 'platform',
    onDemand: false,
  },
  {
    name: 'media.sweep-orphans',
    schedule: CronExpression.EVERY_HOUR,
    description: 'Removes uploaded files that were never attached to anything.',
    surface: 'platform',
    onDemand: true,
  },
  {
    name: 'listings.infected-documents',
    schedule: CronExpression.EVERY_30_MINUTES,
    description:
      'Acts on supporting documents a virus scan rejected: the listing is held and the reviewer ' +
      'told.',
    surface: 'platform',
    onDemand: false,
  },
  {
    name: 'retention.purge-documents',
    schedule: CronExpression.EVERY_DAY_AT_3AM,
    description: 'Deletes superseded verification documents whose ninety days are up (§2.9).',
    surface: 'platform',
    onDemand: false,
  },
  {
    name: 'data-exports.build',
    schedule: CronExpression.EVERY_5_MINUTES,
    description:
      'Builds the subject access requests members have asked for and emails them the link (§13.7).',
    surface: 'platform',
    onDemand: true,
  },
  {
    name: 'idempotency.sweep',
    schedule: CronExpression.EVERY_6_HOURS,
    description: 'Clears idempotency records past their window.',
    surface: 'platform',
    onDemand: true,
  },
  {
    name: 'professionals.response-times',
    schedule: CronExpression.EVERY_DAY_AT_4AM,
    description: 'Recomputes each listing’s median first-response time from its real replies.',
    surface: 'platform',
    onDemand: true,
  },
  {
    name: 'intelligence.demand',
    schedule: CronExpression.EVERY_2_HOURS,
    description: 'Rebuilds the unmet-demand picture behind Circl Intelligence.',
    surface: 'platform',
    onDemand: true,
  },
  {
    name: 'intelligence.auto-guides',
    schedule: CronExpression.EVERY_DAY_AT_2AM,
    description: 'Drafts guides for demand nothing answers, for a reviewer to approve or reject.',
    surface: 'platform',
    onDemand: true,
  },
  {
    name: 'intelligence.search-demand',
    schedule: CronExpression.EVERY_DAY_AT_4AM,
    description: 'Rolls up what members searched for and found nothing against.',
    surface: 'platform',
    onDemand: true,
  },
  {
    name: 'intelligence.metrics',
    schedule: CronExpression.EVERY_DAY_AT_5AM,
    description: 'Rebuilds the nightly metric rollups the dashboard reads.',
    surface: 'platform',
    onDemand: true,
  },
  {
    name: 'safety.rescan-degraded',
    schedule: CronExpression.EVERY_10_MINUTES,
    description:
      'Re-queues scans that ran while the classifier was unavailable, so nothing stays judged by ' +
      'the lexicon alone (§6.7).',
    surface: 'platform',
    onDemand: true,
  },
];

/** The queue name each surface's runs are logged under, so one history reads as one list. */
export const JOB_QUEUES = { platform: 'platform-jobs', admin: 'admin-jobs' } as const;

export const jobDefinition = (name: string): JobDefinition | undefined =>
  JOB_CATALOGUE.find(job => job.name === name);
