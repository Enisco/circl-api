import { PrismaClient } from '@prisma/client';
import { seedCities } from '../../../prisma/seeders/city.seeder';
import { seedPermissions } from '../../../prisma/seeders/permission.seeder';
import { seedRiskTerms } from '../../../prisma/seeders/risk-term.seeder';
import { seedRoles } from '../../../prisma/seeders/role.seeder';
import { seedSupportResources } from '../../../prisma/seeders/support-resource.seeder';
import { seedTaxonomy } from '../../../prisma/seeders/taxonomy.seeder';
import { seedDemo } from '../../../prisma/seeders/demo';

/** `RUN_SEED` unset means yes: the app cannot serve a request without its taxonomy and cities. */
const isEnabled = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === '') return fallback;

  return value.toLowerCase() === 'true' || value === '1';
};

/**
 * Seeding on boot, governed by two environment variables.
 *
 * `RUN_SEED` covers the reference data every environment needs and every environment shares:
 * permissions, roles, cities, taxonomy, risk terms and support resources. All upserts, so running
 * it on every boot is safe.
 *
 * `RUN_DEMO_SEED` additionally builds the Appendix B dataset: ten invented members and everything
 * they have done. It implies the base seed, because the demo data is validated against the
 * taxonomy and cities that seed creates. It refuses to run in production, and that refusal lives
 * inside `seedDemo` rather than here, so no caller can route around it.
 */
export const runStartupSeeds = async (
  prisma: PrismaClient,
  env: NodeJS.ProcessEnv,
  log: { info: (message: string) => void; warn: (message: string) => void },
): Promise<void> => {
  const demo = isEnabled(env.RUN_DEMO_SEED, false);
  // Demo data is validated against the taxonomy, so it cannot run without the base seed.
  const base = demo || isEnabled(env.RUN_SEED, true);

  if (!base) {
    log.info('RUN_SEED is off, skipping the reference data seed.');

    return;
  }

  try {
    await seedPermissions(prisma);
    await seedRoles(prisma);
    await seedCities(prisma);
    await seedTaxonomy(prisma);
    await seedRiskTerms(prisma);
    await seedSupportResources(prisma);
  } catch (error) {
    // Without a taxonomy every code validation fails, so this is not survivable.
    log.warn(`Reference data seed failed: ${(error as Error).message}`);
    throw error;
  }

  if (!demo) return;

  try {
    await seedDemo(prisma);
  } catch (error) {
    // The demo dataset writes to S3 and fetches map tiles, so it can fail for reasons that say
    // nothing about the app. It is sample data: log it and serve.
    log.warn(`Demo dataset seed failed, continuing without it: ${(error as Error).message}`);
  }
};
