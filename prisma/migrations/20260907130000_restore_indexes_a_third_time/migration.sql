-- The third restore of the same seventeen indexes.
--
-- `20260907071851_push_notifications` contains nothing but seventeen DROP INDEX statements. It was
-- not written by hand: `prisma migrate dev` proposes dropping every index Prisma cannot express in
-- a schema, and it re-proposes them on EVERY subsequent migration, so accepting one migration
-- accepts all seventeen drops. Nothing failed when they went, which is exactly the problem: the
-- fifteen trigram indexes are a silent fall back to sequential scans, and the two partial unique
-- indexes are correctness rules the database quietly stopped enforcing.
--
-- Restoring them is only half the fix. `src/infrastructure/database/startup-indexes.ts` now
-- re-asserts them on every boot, so the next restart heals this instead of waiting for somebody to
-- run the test that notices.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── The fifteen trigram indexes every `q=` filter reads ──────────────────────
CREATE INDEX IF NOT EXISTS "community_requests_title_trgm_idx" ON "community_requests" USING GIN ("title" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "community_requests_description_trgm_idx" ON "community_requests" USING GIN ("description" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "community_offers_title_trgm_idx" ON "community_offers" USING GIN ("title" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "guides_title_trgm_idx" ON "guides" USING GIN ("title" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "guides_intro_trgm_idx" ON "guides" USING GIN ("intro" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "groups_name_trgm_idx" ON "groups" USING GIN ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "stores_name_trgm_idx" ON "stores" USING GIN ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "store_items_name_trgm_idx" ON "store_items" USING GIN ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "professional_listings_title_trgm_idx" ON "professional_listings" USING GIN ("profession_title" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "users_first_name_trgm_idx" ON "users" USING GIN ("first_name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "users_last_name_trgm_idx" ON "users" USING GIN ("last_name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "users_username_trgm_idx" ON "users" USING GIN ("username" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "connect_profiles_looking_for_trgm_idx" ON "connect_profiles" USING GIN ("looking_for" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "user_profile_bio_trgm_idx" ON "user_profile" USING GIN ("bio" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "user_profile_can_help_with_trgm_idx" ON "user_profile" USING GIN ("can_help_with" gin_trgm_ops);

-- ── The two rules Postgres cannot be told any other way ──────────────────────
-- One offer of help per person per request. A plain unique key does not express it: the table also
-- holds ordinary replies, and NULLs are distinct in Postgres, so only a partial index can.
CREATE UNIQUE INDEX IF NOT EXISTS "request_responses_one_offer_per_author_idx"
  ON "request_responses" ("request_id", "author_id") WHERE "is_help_offer" = true;

-- One prior-work review per pair. `booking_id` is NULL for prior work, and NULLs being distinct
-- means the table's own unique key never covers it.
CREATE UNIQUE INDEX IF NOT EXISTS "reviews_one_prior_work_per_pair_idx"
  ON "reviews" ("reviewer_id", "subject_user_id") WHERE "booking_id" IS NULL;
