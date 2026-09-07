-- Search reads with ILIKE '%term%' and with pg_trgm's `%` similarity operator. Neither can use a
-- B-tree, so without a GIN index over gin_trgm_ops every one of them is a sequential scan of the
-- whole table. The nine that already existed cover Community, Commerce and Professionals; these six
-- cover the two things search newly reads: people by name, and Connect profiles by their own text.
--
-- Prisma cannot express a GIN index, so `migrate dev` proposes DROPping all fifteen on every later
-- migration. That has already been accepted twice. `test/e2e/schema-indexes.e2e.cjs` is the guard.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- PERSON matches display name and username only (never bio), so exactly three columns are indexed.
CREATE INDEX IF NOT EXISTS "users_first_name_trgm_idx" ON "users" USING GIN ("first_name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "users_last_name_trgm_idx" ON "users" USING GIN ("last_name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "users_username_trgm_idx" ON "users" USING GIN ("username" gin_trgm_ops);

-- Connect discovery has matched bio and "can help with" since it shipped, unindexed. `looking_for`
-- is new to the filter.
CREATE INDEX IF NOT EXISTS "connect_profiles_looking_for_trgm_idx" ON "connect_profiles" USING GIN ("looking_for" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "user_profile_bio_trgm_idx" ON "user_profile" USING GIN ("bio" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "user_profile_can_help_with_trgm_idx" ON "user_profile" USING GIN ("can_help_with" gin_trgm_ops);
