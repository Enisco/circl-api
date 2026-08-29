import { PrismaClient } from '@prisma/client';
import { riskTermSeeds } from './data/risk-terms';

/** Seeds Circl Guard's starting lexicon. */
export const seedRiskTerms = async (prisma: PrismaClient) => {
  console.info('Seeding Guard risk terms...');

  await prisma.$transaction(
    async tx => {
      for (const [category, pattern, weight] of riskTermSeeds) {
        await tx.riskTerm.upsert({
          where: { category_pattern: { category, pattern } },
          update: { weight },
          create: { category, pattern, weight, isActive: true },
        });
      }
    },
    { timeout: 60000, maxWait: 65000 },
  );

  console.info(`  ✅ Seeded ${riskTermSeeds.length} risk terms`);
};
