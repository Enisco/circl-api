import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';
import { Pool } from 'pg';
import {
  NO_COUNTRY,
  countryCodeFromName,
} from '../src/modules/platform/shared/serializers/country.serializer';

/**
 * Fills `UserProfile.countryOfOriginCode` from whatever `countryOfOrigin` already holds.
 *
 * That column has taken whatever each client sent over the years: sometimes a code, sometimes a
 * name, sometimes a name spelled differently. None of that can be grouped, which is why the code
 * column exists — and why this is a script rather than SQL: the mapping lives in the same
 * serializer the live write path uses, so the backfill and the forward path cannot disagree.
 *
 * Anything it cannot resolve is **reported, not guessed**. A country nobody can map is better left
 * null than filed under the nearest-looking code: a filter is only worth having if its buckets are
 * true.
 *
 *   pnpm backfill:country-codes          # report only
 *   pnpm backfill:country-codes --write
 */
const main = async () => {
  const write = process.argv.includes('--write');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool as unknown as ConstructorParameters<typeof PrismaPg>[0]);
  const prisma = new PrismaClient({ adapter, log: ['error'] });

  try {
    const profiles = await prisma.userProfile.findMany({
      where: { countryOfOrigin: { not: null }, countryOfOriginCode: null },
      select: { userId: true, countryOfOrigin: true },
    });

    const resolved = new Map<string, string>();
    const unmatched = new Map<string, number>();

    for (const profile of profiles) {
      const raw = profile.countryOfOrigin!.trim();

      // "Somewhere else" is not a country and must not become a bucket.
      if (!raw || raw.toUpperCase() === NO_COUNTRY) continue;

      const code = countryCodeFromName(raw);

      if (code) {
        resolved.set(profile.userId, code);
      } else {
        unmatched.set(raw, (unmatched.get(raw) ?? 0) + 1);
      }
    }

    console.info(`\n  Profiles with a country and no code: ${profiles.length}`);
    console.info(`  Resolved: ${resolved.size}`);
    console.info(`  Unmatched: ${[...unmatched.values()].reduce((total, n) => total + n, 0)}`);

    if (unmatched.size) {
      console.info('\n  These values resolve to nothing and are being left null:');
      for (const [value, count] of [...unmatched].sort((a, b) => b[1] - a[1])) {
        console.info(`    ${String(count).padStart(5)}  ${JSON.stringify(value)}`);
      }
      console.info(
        '\n  Either they are not countries, or the country list needs the spelling. Decide per ' +
          'value; do not map them to the nearest guess.',
      );
    }

    if (!write) {
      console.info('\n  Nothing written. Re-run with --write to apply.\n');

      return;
    }

    // Grouped by code so this is one statement per country rather than one per member.
    const byCode = new Map<string, string[]>();

    for (const [userId, code] of resolved) {
      byCode.set(code, [...(byCode.get(code) ?? []), userId]);
    }

    for (const [code, userIds] of byCode) {
      await prisma.userProfile.updateMany({
        where: { userId: { in: userIds } },
        data: { countryOfOriginCode: code },
      });
    }

    console.info(`\n  ✅ Wrote ${resolved.size} codes across ${byCode.size} countries.\n`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
};

void main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
