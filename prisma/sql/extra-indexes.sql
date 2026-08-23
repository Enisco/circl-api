-- ═════════════════════════════════════════════════════════════════════════════
-- Indexes and constraints the Prisma schema cannot express.
--
-- `prisma migrate diff` only knows what is in the .prisma files, so anything
-- here is invisible to it and gets dropped from every generated migration.
-- scripts/new-migration.sh strips those DROPs and re-appends this file, so the
-- statements below are the single source of truth for them.
--
-- Everything here is idempotent: the file is replayed by every migration.
-- ═════════════════════════════════════════════════════════════════════════════

-- Circl Intelligence matches guides to a draft request in under 400ms while a
-- member waits to post (1.6.5), and every `q` filter in the spec searches a
-- title and a body. Trigram GIN turns those ILIKEs from sequential scans into
-- index scans, which matters at 100,000 rows and not at 100.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "community_requests_title_trgm_idx" ON "community_requests" USING GIN ("title" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "community_requests_description_trgm_idx" ON "community_requests" USING GIN ("description" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "community_offers_title_trgm_idx" ON "community_offers" USING GIN ("title" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "guides_title_trgm_idx" ON "guides" USING GIN ("title" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "guides_intro_trgm_idx" ON "guides" USING GIN ("intro" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "groups_name_trgm_idx" ON "groups" USING GIN ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "stores_name_trgm_idx" ON "stores" USING GIN ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "store_items_name_trgm_idx" ON "store_items" USING GIN ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "professional_listings_title_trgm_idx" ON "professional_listings" USING GIN ("profession_title" gin_trgm_ops);

-- A member may post several plain replies to a request but only ONE help offer
-- (1.3.2), which is what keeps `helper_count` equal to the number of distinct
-- people. A plain UNIQUE over (request_id, author_id, is_help_offer) would also
-- block the second plain reply, so the constraint is scoped to the offers.
CREATE UNIQUE INDEX IF NOT EXISTS "request_responses_one_offer_per_author_idx"
  ON "request_responses" ("request_id", "author_id")
  WHERE "is_help_offer" AND "deleted_at" IS NULL;

-- "One per pair, ever" for prior-work reviews (2.5.2). The table's own unique key
-- is (reviewer_id, context, source_id), and prior-work carries no source —
-- Postgres treats those NULLs as distinct, so it needs its own index.
CREATE UNIQUE INDEX IF NOT EXISTS "reviews_one_prior_work_per_pair_idx"
  ON "reviews" ("reviewer_id", "subject_user_id")
  WHERE "context" = 'PRIOR_WORK' AND "deleted_at" IS NULL;
