import { Prisma, PrismaClient } from '@prisma/client';
import { taxonomySeeds } from './data/taxonomy';

/**
 * Metadata keys the **operator** owns, not this file.
 *
 * Everything else in a term's metadata is code: a label, a regulator's name, a price band. These
 * are decisions somebody takes in the portal, and the seeder runs on every boot — so writing the
 * seeded value over them would mean a configuration screen whose changes survive until the next
 * deploy and then quietly revert. The screen would look like it worked. That is worse than not
 * having it.
 *
 * So for these keys the seeded value is a **default for a row that does not exist yet**, and the
 * live value wins for one that does.
 *
 * - `requiresReview` — which professions hold their listings for approval (§2.9), changed from the
 *   portal by Trust & Safety, managers and super admins.
 * - `requiresVerification` — the v2 gate: whether selling in this category or subcategory needs an
 *   approved verification. The portal is where a gate is turned on or off (v2 §12), and a deploy
 *   that reverted it would silently un-gate regulated work.
 * - `credentialBodies` — which regulator a reviewer should expect to see. Same reason: the portal
 *   edits it, and a register that gets renamed should not wait for a release.
 */
const OPERATOR_OWNED = ['requiresReview', 'requiresVerification', 'credentialBodies'] as const;

/** Upserts every taxonomy term and bumps the version stamp. */
export const seedTaxonomy = async (prisma: PrismaClient) => {
  console.info('Seeding taxonomy...');

  await prisma.$transaction(
    async tx => {
      // Read first, in one query rather than one per term: the merge below needs to know which
      // rows already exist and what the operator has set on them.
      const existing = await tx.taxonomyTerm.findMany({
        select: { kind: true, code: true, metadata: true },
      });
      const live = new Map(existing.map(term => [`${term.kind}:${term.code}`, term.metadata]));

      for (const term of taxonomySeeds) {
        const current = live.get(`${term.kind}:${term.code}`) as Record<string, unknown> | null;
        const metadata = { ...((term.metadata as Record<string, unknown> | undefined) ?? {}) };

        if (current) {
          for (const key of OPERATOR_OWNED) {
            if (key in current) metadata[key] = current[key];
          }
        }

        await tx.taxonomyTerm.upsert({
          where: { kind_code: { kind: term.kind, code: term.code } },
          update: {
            label: term.label,
            description: term.description ?? null,
            sort: term.sort,
            metadata: (metadata as Prisma.InputJsonValue) ?? undefined,
          },
          create: {
            kind: term.kind,
            code: term.code,
            label: term.label,
            description: term.description ?? null,
            sort: term.sort,
            isActive: term.isActive ?? true,
            metadata: (metadata as Prisma.InputJsonValue) ?? undefined,
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
