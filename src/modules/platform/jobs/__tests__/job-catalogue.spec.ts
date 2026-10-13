import { readFileSync } from 'fs';
import { join } from 'path';
import { CronExpression } from '@nestjs/schedule';
import { JOB_CATALOGUE, jobDefinition } from '../job-catalogue';

/**
 * The catalogue against the code (§5.22).
 *
 * `admin/jobs` is served from a declared list rather than from Nest's `SchedulerRegistry`, because
 * the registry only knows the jobs registered in *this* process and the admin surface deliberately
 * does not schedule the platform's. That trade buys a complete list and costs a second place to
 * forget, so this is the test that makes forgetting loud: a `@Cron` with no catalogue entry is a
 * job nobody can see on the configuration screen, and a catalogue entry with no `@Cron` is a row
 * whose "next run" never comes.
 *
 * Read out of the source rather than from the registry on purpose — instantiating either service
 * means instantiating sixteen collaborators, and what is being checked is the declaration.
 */
const sourceOf = (file: string): string =>
  readFileSync(join(__dirname, '..', '..', '..', file), 'utf8');

const cronNamesIn = (source: string): string[] =>
  [...source.matchAll(/@Cron\(CronExpression\.(\w+), \{ name: '([^']+)' \}\)/g)].map(
    match => match[2],
  );

const scheduleOf = (source: string, name: string): string | null => {
  const match = new RegExp(`@Cron\\(CronExpression\\.(\\w+), \\{ name: '${name}' \\}\\)`).exec(
    source,
  );

  return match ? (CronExpression[match[1] as keyof typeof CronExpression] as string) : null;
};

const PLATFORM = sourceOf('platform/jobs/platform-jobs.service.ts');
const ADMIN = sourceOf('admin/jobs/admin-jobs.service.ts');

describe('the job catalogue', () => {
  const declared = new Set(JOB_CATALOGUE.map(job => job.name));
  const scheduled = [...cronNamesIn(PLATFORM), ...cronNamesIn(ADMIN)];

  it('finds the decorators it is meant to be checking', () => {
    // The sentinel. A regex that stops matching would make every assertion below pass over
    // nothing, which is the one failure this kind of test cannot otherwise report.
    expect(scheduled.length).toBeGreaterThan(15);
  });

  it('describes every scheduled job', () => {
    expect(scheduled.filter(name => !declared.has(name))).toEqual([]);
  });

  it('declares no job that is not scheduled', () => {
    const live = new Set(scheduled);

    expect(JOB_CATALOGUE.filter(job => !live.has(job.name)).map(job => job.name)).toEqual([]);
  });

  it('records each one’s real schedule, not an approximation of it', () => {
    for (const job of JOB_CATALOGUE) {
      const source = job.surface === 'admin' ? ADMIN : PLATFORM;

      expect(scheduleOf(source, job.name)).toBe(job.schedule);
    }
  });

  it('puts each job on the surface that actually runs it', () => {
    // This is what `disabledOnThisInstance` is computed from, so getting it wrong tells a staff
    // member a job is unavailable on the host that runs it, or offers them a Run now that 409s.
    for (const job of JOB_CATALOGUE) {
      const inAdmin = cronNamesIn(ADMIN).includes(job.name);

      expect(job.surface).toBe(inAdmin ? 'admin' : 'platform');
    }
  });

  it('only marks a job on-demand when a runner will actually take it', () => {
    // `runNow` has its own table in each service, and a job absent from it answers 404. A
    // catalogue claiming otherwise is a button that cannot work.
    const runnable = new Set([
      ...[...PLATFORM.matchAll(/'([a-z.-]+)': \(\) => this\.\w+\(\)/g)].map(m => m[1]),
      ...[...ADMIN.matchAll(/'([a-z.-]+)': \(\) => this\.\w+\(\)/g)].map(m => m[1]),
    ]);

    for (const job of JOB_CATALOGUE) {
      expect(job.onDemand).toBe(runnable.has(job.name));
    }
  });

  it('gives every job a description somebody could act on', () => {
    for (const job of JOB_CATALOGUE) {
      // The reason the catalogue exists at all: neither the registry nor the on-demand table has
      // anywhere to put one, and "what does `listings.infected-documents` do" is the question the
      // screen exists to answer.
      expect(job.description.length).toBeGreaterThan(30);
      expect(job.description).toMatch(/\.$/);
    }
  });

  it('is addressable by name', () => {
    expect(jobDefinition('data-exports.build')?.surface).toBe('platform');
    expect(jobDefinition('exports.expire')?.surface).toBe('admin');
    expect(jobDefinition('nothing.like-this')).toBeUndefined();
  });
});
