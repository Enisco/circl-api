import { PrismaClient } from '@prisma/client';
import ukCities from './data/uk-cities.json';

export const seedCities = async (prisma: PrismaClient) => {
  console.info('Seeding UK cities...');

  await prisma.$transaction(
    async tx => {
      for (const city of ukCities) {
        await tx.city.upsert({
          where: { id: city.id },
          update: { name: city.name },
          create: city,
        });
      }
    },
    { timeout: 30000, maxWait: 35000 },
  );

  console.info(`  ✅ Seeded ${ukCities.length} UK cities`);
};
