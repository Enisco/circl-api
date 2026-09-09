-- The fourth restore. `prisma migrate dev` proposes DROPping every hand-written index on every
-- migration, because none of them can be expressed in a Prisma schema, and the proposal was
-- accepted again in 20260909132948. Nothing fails when they go: the fifteen trigram indexes
-- silently become sequential scans and the two unique ones stop being enforced.
--
-- `src/infrastructure/database/startup-indexes.ts` re-asserts all of these on every boot, which is
-- what keeps a developer's database working in the meantime. This file is what makes a database
-- built from migrations alone correct.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "community_requests_title_trgm_idx"
  ON "community_requests" USING gin ("title" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "community_requests_description_trgm_idx"
  ON "community_requests" USING gin ("description" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "community_offers_title_trgm_idx"
  ON "community_offers" USING gin ("title" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "guides_title_trgm_idx"
  ON "guides" USING gin ("title" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "guides_intro_trgm_idx"
  ON "guides" USING gin ("intro" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "groups_name_trgm_idx"
  ON "groups" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "stores_name_trgm_idx"
  ON "stores" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "store_items_name_trgm_idx"
  ON "store_items" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "professional_listings_title_trgm_idx"
  ON "professional_listings" USING gin ("profession_title" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "users_first_name_trgm_idx"
  ON "users" USING gin ("first_name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "users_last_name_trgm_idx"
  ON "users" USING gin ("last_name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "users_username_trgm_idx"
  ON "users" USING gin ("username" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "connect_profiles_looking_for_trgm_idx"
  ON "connect_profiles" USING gin ("looking_for" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "user_profile_bio_trgm_idx"
  ON "user_profile" USING gin ("bio" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "user_profile_can_help_with_trgm_idx"
  ON "user_profile" USING gin ("can_help_with" gin_trgm_ops);

CREATE UNIQUE INDEX IF NOT EXISTS "request_responses_one_offer_per_author_idx"
  ON "request_responses" ("request_id", "author_id") WHERE "is_help_offer" = true;

CREATE UNIQUE INDEX IF NOT EXISTS "reviews_one_prior_work_per_pair_idx"
  ON "reviews" ("reviewer_id", "subject_user_id")
  WHERE "context" = 'PRIOR_WORK' AND "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "media_derived_at_idx"
  ON "media" ("derived_at") WHERE "derived_at" IS NULL;
