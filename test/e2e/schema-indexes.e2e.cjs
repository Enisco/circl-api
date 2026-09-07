/* The seventeen indexes Prisma cannot see.
 *
 * Fifteen trigram GIN indexes and two partial unique indexes are written by hand in migrations,
 * because neither can be expressed in a Prisma schema. That means `prisma migrate dev` proposes
 * DROPping all seventeen on EVERY subsequent migration, and one of those DROPs was accepted: they
 * were absent from the database for a whole release.
 *
 * Nothing failed when they went, which is the point of this file. The fifteen are a silent fall back
 * to sequential scans, and the two are correctness rules the database quietly stopped enforcing.
 *
 * It has now happened three times, so the app no longer relies on somebody running this file:
 * `src/infrastructure/database/startup-indexes.ts` re-asserts all seventeen on every boot and warns
 * by name about any it had to recreate. This file is still the thing that fails a build; the boot
 * guard is what stops a developer's database sitting broken in the meantime. */
const { check, finish, prisma } = require('./harness.cjs');

const TRIGRAM = [
  'community_requests_title_trgm_idx',
  'community_requests_description_trgm_idx',
  'community_offers_title_trgm_idx',
  'guides_title_trgm_idx',
  'guides_intro_trgm_idx',
  'groups_name_trgm_idx',
  'stores_name_trgm_idx',
  'store_items_name_trgm_idx',
  'professional_listings_title_trgm_idx',
  // Search reads these six: people by name, and Connect profiles by their own text.
  'users_first_name_trgm_idx',
  'users_last_name_trgm_idx',
  'users_username_trgm_idx',
  'connect_profiles_looking_for_trgm_idx',
  'user_profile_bio_trgm_idx',
  'user_profile_can_help_with_trgm_idx',
];

const PARTIAL_UNIQUE = [
  'request_responses_one_offer_per_author_idx',
  'reviews_one_prior_work_per_pair_idx',
];

(async () => {
  const rows = await prisma.$queryRaw`
    SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
  `;
  const byName = new Map(rows.map(row => [row.indexname, row.indexdef]));

  console.log('\n── Search indexes ───────────────────────────────────────────');
  for (const name of TRIGRAM) {
    check(`${name} exists`, byName.has(name), 'missing — a q= filter just became a table scan');
  }
  check('all fifteen are GIN over gin_trgm_ops',
    TRIGRAM.every(name => /USING gin/i.test(byName.get(name) ?? '')
      && /gin_trgm_ops/.test(byName.get(name) ?? '')),
    TRIGRAM.filter(name => !/gin_trgm_ops/.test(byName.get(name) ?? '')));

  console.log('\n── Uniqueness the schema cannot express ─────────────────────');
  for (const name of PARTIAL_UNIQUE) {
    check(`${name} exists`, byName.has(name), 'missing — the rule is no longer enforced');
  }
  check('both are UNIQUE and partial',
    PARTIAL_UNIQUE.every(name => {
      const def = byName.get(name) ?? '';

      return /CREATE UNIQUE INDEX/i.test(def) && /WHERE/i.test(def);
    }),
    PARTIAL_UNIQUE.map(name => byName.get(name)));

  console.log('\n── The extension they depend on ─────────────────────────────');
  const ext = await prisma.$queryRaw`SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`;
  check('pg_trgm is installed', ext.length === 1, ext);

  await finish();
})();
