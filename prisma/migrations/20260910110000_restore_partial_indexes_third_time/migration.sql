-- The same three, restored after 20260910101411 dropped them. Third time today, sixth overall.
--
-- Prisma cannot represent a WHERE clause on an index, so `migrate dev` proposes removing every
-- index that has one, every time. The fifteen trigram indexes stopped appearing in that list once
-- they were declared in the schema; these three have no such escape.
--
-- The boot guard puts them back on the next start, which is why nothing ever looks broken. This
-- file is what makes a database built from migrations alone correct.

CREATE UNIQUE INDEX IF NOT EXISTS "request_responses_one_offer_per_author_idx"
  ON "request_responses" ("request_id", "author_id") WHERE "is_help_offer" = true;

CREATE UNIQUE INDEX IF NOT EXISTS "reviews_one_prior_work_per_pair_idx"
  ON "reviews" ("reviewer_id", "subject_user_id")
  WHERE "context" = 'PRIOR_WORK' AND "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "media_derived_at_idx"
  ON "media" ("derived_at") WHERE "derived_at" IS NULL;
