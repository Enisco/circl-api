import { PrismaClient } from '@prisma/client';

/**
 * Re-asserted on every boot, because losing one of these fails silently: a trigram index becomes a
 * sequential scan, a partial unique index stops enforcing its rule.
 *
 * The fifteen trigram indexes are now declared in the Prisma schema with `type: Gin`, so
 * `migrate dev` no longer proposes dropping them. The three partial ones cannot be expressed at
 * all, and are the only ones it still asks about.
 */
const TRIGRAM: Array<[index: string, table: string, column: string]> = [
  ['community_requests_title_trgm_idx', 'community_requests', 'title'],
  ['community_requests_description_trgm_idx', 'community_requests', 'description'],
  ['community_offers_title_trgm_idx', 'community_offers', 'title'],
  ['guides_title_trgm_idx', 'guides', 'title'],
  ['guides_intro_trgm_idx', 'guides', 'intro'],
  ['groups_name_trgm_idx', 'groups', 'name'],
  ['stores_name_trgm_idx', 'stores', 'name'],
  ['store_items_name_trgm_idx', 'store_items', 'name'],
  ['professional_listings_title_trgm_idx', 'professional_listings', 'profession_title'],
  ['users_first_name_trgm_idx', 'users', 'first_name'],
  ['users_last_name_trgm_idx', 'users', 'last_name'],
  ['users_username_trgm_idx', 'users', 'username'],
  ['connect_profiles_looking_for_trgm_idx', 'connect_profiles', 'looking_for'],
  ['user_profile_bio_trgm_idx', 'user_profile', 'bio'],
  ['user_profile_can_help_with_trgm_idx', 'user_profile', 'can_help_with'],
];

/**
 * The partial indexes, which have no representation in a Prisma schema at all: two rules Postgres
 * cannot be told any other way, and one the media sweep reads.
 */
const PARTIAL: Array<[index: string, statement: string]> = [
  [
    'request_responses_one_offer_per_author_idx',
    'CREATE UNIQUE INDEX IF NOT EXISTS "request_responses_one_offer_per_author_idx" ' +
      'ON "request_responses" ("request_id", "author_id") WHERE "is_help_offer" = true',
  ],
  [
    // Not unique, but every bit as invisible: the derivation sweep reads it to find the media it
    // has not measured yet, and without it that becomes a scan of the whole table every hour.
    'media_derived_at_idx',
    'CREATE INDEX IF NOT EXISTS "media_derived_at_idx" ' +
      'ON "media" ("derived_at") WHERE "derived_at" IS NULL',
  ],
  [
    'reviews_one_prior_work_per_pair_idx',
    'CREATE UNIQUE INDEX IF NOT EXISTS "reviews_one_prior_work_per_pair_idx" ' +
      'ON "reviews" ("reviewer_id", "subject_user_id") ' +
      'WHERE "context" = \'PRIOR_WORK\' AND "deleted_at" IS NULL',
  ],
];

export const assertInvisibleIndexes = async (
  prisma: PrismaClient,
  log: { info: (message: string) => void; warn: (message: string) => void },
): Promise<void> => {
  const rows = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'",
  );
  const present = new Set(rows.map(row => row.indexname));
  const missing = [
    ...TRIGRAM.filter(([name]) => !present.has(name)).map(([name, table, column]) => ({
      name,
      statement: `CREATE INDEX IF NOT EXISTS "${name}" ON "${table}" USING GIN ("${column}" gin_trgm_ops)`,
    })),
    ...PARTIAL.filter(([name]) => !present.has(name)).map(([name, statement]) => ({
      name,
      statement,
    })),
  ];

  if (!missing.length) return;

  // Loud, because the interesting question is not that they came back but who dropped them.
  log.warn(
    `${missing.length} index(es) Prisma cannot see were missing and are being recreated: ` +
      `${missing.map(item => item.name).join(', ')}. ` +
      'Something dropped them, most likely an accepted `prisma migrate dev` proposal.',
  );

  await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm');

  for (const item of missing) {
    try {
      await prisma.$executeRawUnsafe(item.statement);
    } catch (error) {
      // A unique index can legitimately fail to build if the rule it enforces is already broken in
      // the data. That is worth saying out loud, and it is not worth refusing to start over.
      log.warn(`Could not recreate ${item.name}: ${(error as Error).message}`);
    }
  }

  log.info(`Recreated ${missing.length} index(es).`);
};
