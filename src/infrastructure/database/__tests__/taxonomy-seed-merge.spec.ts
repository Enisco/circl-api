import { PrismaClient } from '@prisma/client';
import { seedTaxonomy } from '../../../../prisma/seeders/taxonomy.seeder';

/**
 * A setting the portal owns must survive the next deploy.
 *
 * `requiresReview` — which professions hold their listings for approval (§2.9) — is changed by
 * Trust & Safety from the portal, and the taxonomy seeder runs on **every boot** with a `metadata`
 * write. Before this, that write was wholesale: a profession gated on Tuesday was quietly ungated
 * by Thursday's deploy, and an immigration adviser who should have waited for a human went live.
 * The screen would have looked like it worked, which is the worst version of this bug.
 *
 * Driven against a fake client rather than a database, because what is being asserted is the shape
 * of the write: that the seeded default reaches a row that does not exist, and does not reach one
 * that does.
 */
const build = (existing: Array<{ kind: string; code: string; metadata: unknown }>) => {
  const writes: Array<{
    where: unknown;
    update: Record<string, unknown>;
    create: Record<string, unknown>;
  }> = [];
  const tx = {
    taxonomyTerm: {
      findMany: jest.fn(async () => existing),
      upsert: jest.fn(async (args: never) => {
        writes.push(args);

        return {};
      }),
    },
    taxonomyVersion: { upsert: jest.fn(async () => ({})) },
  };
  const prisma = {
    $transaction: jest.fn(async (work: (client: unknown) => Promise<unknown>) => work(tx)),
  } as unknown as PrismaClient;

  return { prisma, writes };
};

/** The write for one profession, whichever order the seeds are in. */
const professionWrite = (
  writes: Array<{
    where: unknown;
    update: Record<string, unknown>;
    create: Record<string, unknown>;
  }>,
  code: string,
) =>
  writes.find(
    write =>
      (write.where as { kind_code?: { kind?: string; code?: string } }).kind_code?.kind ===
        'PROFESSION' &&
      (write.where as { kind_code?: { kind?: string; code?: string } }).kind_code?.code === code,
  );

const metadataOf = (value: Record<string, unknown> | undefined) =>
  (value?.metadata ?? {}) as Record<string, unknown>;

beforeAll(() => {
  jest.spyOn(console, 'info').mockImplementation(() => {});
});

describe('seeding the taxonomy over a database somebody has configured', () => {
  it("keeps the operator's requiresReview and does not write the seeded default over it", async () => {
    // Gated in the portal, and not gated in this file's defaults.
    const { prisma, writes } = build([
      {
        kind: 'PROFESSION',
        code: 'TRADES_REPAIRS',
        metadata: { isRegulated: false, credentialBodies: ['Gas Safe'], requiresReview: true },
      },
    ]);

    await seedTaxonomy(prisma);

    expect(metadataOf(professionWrite(writes, 'TRADES_REPAIRS')?.update).requiresReview).toBe(true);
  });

  it('ungates one the operator turned off, for the same reason in reverse', async () => {
    const { prisma, writes } = build([
      {
        kind: 'PROFESSION',
        code: 'IMMIGRATION',
        metadata: { isRegulated: true, credentialBodies: ['IAA'], requiresReview: false },
      },
    ]);

    await seedTaxonomy(prisma);

    expect(metadataOf(professionWrite(writes, 'IMMIGRATION')?.update).requiresReview).toBe(false);
  });

  it('still carries the seeded default to a row that has never existed', async () => {
    const { prisma, writes } = build([]);

    await seedTaxonomy(prisma);

    // The seven defaults, on a fresh database.
    expect(metadataOf(professionWrite(writes, 'IMMIGRATION')?.create).requiresReview).toBe(true);
    expect(metadataOf(professionWrite(writes, 'TRADES_REPAIRS')?.create).requiresReview).toBe(
      false,
    );
  });

  it('leaves the code-owned keys alone, so a merge is not a licence to keep stale labels', async () => {
    // An old row with a wrong regulator list: that one is this file's to correct.
    const { prisma, writes } = build([
      {
        kind: 'PROFESSION',
        code: 'IMMIGRATION',
        metadata: { isRegulated: false, credentialBodies: ['OISC'], requiresReview: true },
      },
    ]);

    await seedTaxonomy(prisma);

    const update = metadataOf(professionWrite(writes, 'IMMIGRATION')?.update);

    expect(update.isRegulated).toBe(true);
    expect(update.credentialBodies).toEqual(['IAA']);
    expect(update.requiresReview).toBe(true);
  });
});
