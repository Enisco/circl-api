import { PrismaClient } from '@prisma/client';
import ukCities from './data/uk-cities.json';

/**
 * Coordinates are approximate city-centre points: they rank cities, they are not addresses.
 *
 * `region` is the ITL level-1 region — the grouping the ONS uses and the one staff already think
 * in. It is reference data rather than decoration: the admin filter bar offers 103 cities, and a
 * flat list of 103 is the thing grouping exists to fix. The column was in the schema from the
 * start and nothing ever filled it, so `GET admin/analytics/filter-options` grouped every city
 * under nothing.
 */
export const seedCities = async (prisma: PrismaClient) => {
  console.info('Seeding UK cities...');

  await prisma.$transaction(
    async tx => {
      for (const city of ukCities) {
        await tx.city.upsert({
          where: { id: city.id },
          update: {
            name: city.name,
            region: city.region,
            latitude: city.latitude,
            longitude: city.longitude,
          },
          create: city,
        });
      }
    },
    { timeout: 30000, maxWait: 35000 },
  );

  console.info(`  ✅ Seeded ${ukCities.length} UK cities`);
};
