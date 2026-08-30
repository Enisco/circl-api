/* The eleven indexes Prisma cannot see.
 *
 * Nine trigram GIN indexes and two partial unique indexes are written by hand in migrations,
 * because neither can be expressed in a Prisma schema. That means `prisma migrate dev` proposes
 * DROPping all eleven on EVERY subsequent migration, and one of those DROPs was accepted: they
 * were absent from the database for a whole release.
 *
 * Nothing failed when they went, which is the point of this file. The nine are a silent fall back
 * to sequential scans, and the two are correctness rules the database quietly stopped enforcing. */
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
  check('all nine are GIN over gin_trgm_ops',
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
