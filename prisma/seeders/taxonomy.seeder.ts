import { Prisma, PrismaClient } from '@prisma/client';
import { taxonomySeeds } from './data/taxonomy';

/**
 * Upserts every taxonomy term and bumps the version stamp.
 *
 * `label`, `sort` and `metadata` are overwritten on every run so a reworded label
 * ships with a deploy. `isActive` is written on create only: once an admin has
 * turned a category on or off in the dashboard, a redeploy must not undo it.
 */
export const seedTaxonomy = async (prisma: PrismaClient) => {
  console.info('Seeding taxonomy...');

  await prisma.$transaction(
    async tx => {
      for (const term of taxonomySeeds) {
        await tx.taxonomyTerm.upsert({
          where: { kind_code: { kind: term.kind, code: term.code } },
          update: {
            label: term.label,
            description: term.description ?? null,
            sort: term.sort,
            metadata: (term.metadata as Prisma.InputJsonValue) ?? undefined,
          },
          create: {
            kind: term.kind,
            code: term.code,
            label: term.label,
            description: term.description ?? null,
            sort: term.sort,
            isActive: term.isActive ?? true,
            metadata: (term.metadata as Prisma.InputJsonValue) ?? undefined,
          },
        });
      }

      await tx.taxonomyVersion.upsert({
        where: { id: 'SINGLETON' },
        update: { version: new Date() },
        create: { id: 'SINGLETON', version: new Date() },
      });
    },
    { timeout: 60000, maxWait: 65000 },
  );

  console.info(`  ✅ Seeded ${taxonomySeeds.length} taxonomy terms`);
};
