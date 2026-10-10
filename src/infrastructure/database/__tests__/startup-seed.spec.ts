import { PrismaClient } from '@prisma/client';
import { runStartupSeeds } from '../startup-seed';

/**
 * Which seed runs when.
 *
 * The split is the whole point: `RUN_SEED` is reference data a production database cannot serve
 * without — permissions, roles, cities, the taxonomy, the Guard lexicon, the crisis lines — and all
 * of it is upserts. `RUN_DEMO_SEED` is ten invented members and everything they have supposedly
 * done, and it must never reach anything a real member can see.
 *
 * Tested through the gate rather than by reading the seeders, because the gate is where the two get
 * confused: a default inverted here, or an environment signal read with `??` instead of checked,
 * puts invented people in a real database or leaves a real one with no taxonomy.
 */
const mockPrisma = () => ({}) as unknown as PrismaClient;

const silentLog = () => ({ info: jest.fn(), warn: jest.fn() });

jest.mock('../../../../prisma/seeders/permission.seeder', () => ({
  seedPermissions: jest.fn(),
}));
jest.mock('../../../../prisma/seeders/role.seeder', () => ({ seedRoles: jest.fn() }));
jest.mock('../../../../prisma/seeders/city.seeder', () => ({ seedCities: jest.fn() }));
jest.mock('../../../../prisma/seeders/taxonomy.seeder', () => ({ seedTaxonomy: jest.fn() }));
jest.mock('../../../../prisma/seeders/risk-term.seeder', () => ({ seedRiskTerms: jest.fn() }));
jest.mock('../../../../prisma/seeders/support-resource.seeder', () => ({
  seedSupportResources: jest.fn(),
}));
jest.mock('../../../../prisma/seeders/demo', () => ({ seedDemo: jest.fn() }));

/* eslint-disable @typescript-eslint/no-require-imports */
const base = () => [
  require('../../../../prisma/seeders/permission.seeder').seedPermissions,
  require('../../../../prisma/seeders/role.seeder').seedRoles,
  require('../../../../prisma/seeders/city.seeder').seedCities,
  require('../../../../prisma/seeders/taxonomy.seeder').seedTaxonomy,
  require('../../../../prisma/seeders/risk-term.seeder').seedRiskTerms,
  require('../../../../prisma/seeders/support-resource.seeder').seedSupportResources,
];

const demo = () => require('../../../../prisma/seeders/demo').seedDemo;
/* eslint-enable @typescript-eslint/no-require-imports */

describe('runStartupSeeds', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('the reference data', () => {
    it('runs when nothing is set — a database with no taxonomy cannot validate a single code', async () => {
      await runStartupSeeds(mockPrisma(), {}, silentLog());

      for (const seeder of base()) expect(seeder).toHaveBeenCalledTimes(1);
    });

    it('runs in production, because it is upserts of data production needs', async () => {
      await runStartupSeeds(mockPrisma(), { NODE_ENV: 'production' }, silentLog());

      for (const seeder of base()) expect(seeder).toHaveBeenCalledTimes(1);
    });

    it('can be turned off deliberately', async () => {
      await runStartupSeeds(mockPrisma(), { RUN_SEED: 'false' }, silentLog());

      for (const seeder of base()) expect(seeder).not.toHaveBeenCalled();
    });

    it('is not optional when the demo seed is on, which validates against it', async () => {
      await runStartupSeeds(
        mockPrisma(),
        { RUN_SEED: 'false', RUN_DEMO_SEED: 'true' },
        silentLog(),
      );

      for (const seeder of base()) expect(seeder).toHaveBeenCalledTimes(1);
    });

    it('stops the boot when it fails — serving without a taxonomy is not survivable', async () => {
      base()[3].mockRejectedValueOnce(new Error('no taxonomy'));

      await expect(runStartupSeeds(mockPrisma(), {}, silentLog())).rejects.toThrow('no taxonomy');
    });
  });

  describe('the demo dataset', () => {
    it('is off unless asked for', async () => {
      await runStartupSeeds(mockPrisma(), {}, silentLog());

      expect(demo()).not.toHaveBeenCalled();
    });

    it('runs when asked for', async () => {
      await runStartupSeeds(mockPrisma(), { RUN_DEMO_SEED: 'true' }, silentLog());

      expect(demo()).toHaveBeenCalledTimes(1);
    });

    it('does not stop the boot when it fails — it is sample data, not the app', async () => {
      const log = silentLog();

      demo().mockRejectedValueOnce(new Error('S3 unreachable'));

      await expect(
        runStartupSeeds(mockPrisma(), { RUN_DEMO_SEED: 'true' }, log),
      ).resolves.toBeUndefined();
      expect(log.warn).toHaveBeenCalled();
    });
  });
});

/**
 * The guard inside `seedDemo`, restated.
 *
 * It lives in the seeder rather than in the gate so that no caller can route around it — `seed.ts`,
 * `seed-demo.ts`, a script somebody writes next year. This asserts the logic that guard uses,
 * because the version it replaced (`NODE_ENV ?? APP_ENV`) was wrong in exactly one configuration:
 * `??` falls through on *unset*, not on *different*, so `NODE_ENV=staging` with
 * `APP_ENV=production` read as staging.
 */
describe('the production refusal', () => {
  const refuses = (env: { NODE_ENV?: string; APP_ENV?: string }): boolean =>
    [env.NODE_ENV, env.APP_ENV].includes('production');

  it.each([
    ['NODE_ENV alone', { NODE_ENV: 'production' }],
    ['APP_ENV alone', { APP_ENV: 'production' }],
    ['both', { NODE_ENV: 'production', APP_ENV: 'production' }],
    [
      'NODE_ENV says staging while APP_ENV says production',
      {
        NODE_ENV: 'staging',
        APP_ENV: 'production',
      },
    ],
  ])('refuses when %s says production', (_name, env) => {
    expect(refuses(env)).toBe(true);
  });

  it.each([
    ['nothing set', {}],
    ['development', { NODE_ENV: 'development', APP_ENV: 'development' }],
    ['test', { NODE_ENV: 'test', APP_ENV: 'test' }],
  ])('allows it when %s', (_name, env) => {
    expect(refuses(env)).toBe(false);
  });
});
