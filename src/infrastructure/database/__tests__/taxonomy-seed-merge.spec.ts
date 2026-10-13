import { PrismaClient } from '@prisma/client';
import { seedTaxonomy } from '../../../../prisma/seeders/taxonomy.seeder';

/**
 * A setting the portal owns must survive the next deploy.
 *
 * Three keys are the portal's: `requiresReview` (the old per-listing gate, §2.9),
 * `requiresVerification` (v2's per-category gate, §3.2) and `credentialBodies` (which regulator a
 * reviewer should expect). All three are changed by Trust & Safety from the portal, and the
 * taxonomy seeder runs on **every boot** with a `metadata` write. Before this, that write was wholesale: a profession gated on Tuesday was quietly ungated
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

/** The same, for one subcategory. */
const subcategoryWrite = (
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
        'PROFESSION_SUBCATEGORY' &&
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

    /**
     * On a fresh database **nothing is gated at the category level**, which is Professionals v2's
     * change rather than a relaxation (v2 §3.2).
     *
     * `requiresReview` was the old per-*listing* gate and is off everywhere: holding a category
     * grants nothing now, so there is nothing for it to protect. The gate moved to the
     * subcategory, where *Immigration solicitor* is regulated and *Immigration* is not — and it is
     * enforced per service against an approved `(professional, category)` verification.
     */
    expect(metadataOf(professionWrite(writes, 'IMMIGRATION')?.create).requiresReview).toBe(false);
    expect(metadataOf(professionWrite(writes, 'IMMIGRATION')?.create).requiresVerification).toBe(
      false,
    );
    expect(
      metadataOf(subcategoryWrite(writes, 'IMMIGRATION_SOLICITOR')?.create).requiresVerification,
    ).toBe(true);
    expect(
      metadataOf(subcategoryWrite(writes, 'IMMIGRATION_VISA_SUPPORT')?.create).requiresVerification,
    ).toBe(false);
  });

  /**
   * The gate and the regulator are the portal's now too (v2 §12).
   *
   * Trust & Safety sets `requiresVerification` per term from the taxonomy editor, and a register
   * that gets renamed should not wait for a release — so `credentialBodies` goes with it. Both are
   * operator-owned for the same reason `requiresReview` already was: a deploy that reverted them
   * would un-gate regulated work, and the screen would look like it had worked.
   */
  it('keeps the gate and the regulator the portal set, and still corrects what it owns', async () => {
    const { prisma, writes } = build([
      {
        kind: 'PROFESSION',
        code: 'IMMIGRATION',
        // A row somebody has edited: the old regulator name, gated at the category level, and
        // `isRegulated` wrong — only the last of those is this file's to fix.
        metadata: {
          isRegulated: false,
          credentialBodies: ['OISC'],
          requiresReview: true,
          requiresVerification: true,
        },
      },
    ]);

    await seedTaxonomy(prisma);

    const update = metadataOf(professionWrite(writes, 'IMMIGRATION')?.update);

    expect(update.isRegulated).toBe(true);
    expect(update.credentialBodies).toEqual(['OISC']);
    expect(update.requiresReview).toBe(true);
    expect(update.requiresVerification).toBe(true);
  });

  it('carries a subcategory’s parent, which is structure rather than policy', async () => {
    const { prisma, writes } = build([
      {
        kind: 'PROFESSION_SUBCATEGORY',
        code: 'IMMIGRATION_SOLICITOR',
        // Somebody's attempt to reparent it, which is not theirs to make: a child under the wrong
        // shelf is a chip in the wrong picker, and the hierarchy is the seed's.
        metadata: { parentCode: 'LEGAL', requiresVerification: true },
      },
    ]);

    await seedTaxonomy(prisma);

    expect(metadataOf(subcategoryWrite(writes, 'IMMIGRATION_SOLICITOR')?.update).parentCode).toBe(
      'IMMIGRATION',
    );
  });
});
