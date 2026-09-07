import { PrismaClient } from '@prisma/client';

/**
 * The indexes Prisma cannot see, re-asserted on every boot.
 *
 * Neither a GIN index over `gin_trgm_ops` nor a partial unique index can be expressed in a Prisma
 * schema. `prisma migrate dev` therefore treats all seventeen as drift and proposes DROPping them,
 * on every migration, forever. That proposal has been accepted three times now: once in
 * `20260830071030_full_api_spec`, once in `bcc41fa`, and once in `20260907071851`, which contains
 * nothing else at all.
 *
 * Nothing fails when they go, which is what makes it worth guarding rather than remembering. The
 * fifteen trigram indexes are a silent fall back to sequential scans on every `q=` filter in the
 * API, and the two partial unique indexes are correctness rules the database simply stops
 * enforcing.
 *
 * Restoring them by migration only fixes the database that ran the migration. This runs on every
 * start, so the next restart heals it wherever it happened.
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

/** The two rules Postgres cannot be told any other way, because NULLs are distinct. */
const PARTIAL_UNIQUE: Array<[index: string, statement: string]> = [
  [
    'request_responses_one_offer_per_author_idx',
    'CREATE UNIQUE INDEX IF NOT EXISTS "request_responses_one_offer_per_author_idx" ' +
      'ON "request_responses" ("request_id", "author_id") WHERE "is_help_offer" = true',
  ],
  [
    'reviews_one_prior_work_per_pair_idx',
    'CREATE UNIQUE INDEX IF NOT EXISTS "reviews_one_prior_work_per_pair_idx" ' +
      'ON "reviews" ("reviewer_id", "subject_user_id") WHERE "booking_id" IS NULL',
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
    ...PARTIAL_UNIQUE.filter(([name]) => !present.has(name)).map(([name, statement]) => ({
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
