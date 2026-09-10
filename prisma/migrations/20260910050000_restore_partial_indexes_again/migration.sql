-- The same three again, restored after 20260910045102 dropped them. Twice in one evening.
--
-- The fifteen trigram indexes are now declared in the schema and are no longer proposed for
-- dropping. These three carry a WHERE clause, which has no representation in a Prisma schema at
-- all, so `migrate dev` will keep offering to remove them. It is not a schema change to accept.

CREATE UNIQUE INDEX IF NOT EXISTS "request_responses_one_offer_per_author_idx"
  ON "request_responses" ("request_id", "author_id") WHERE "is_help_offer" = true;

CREATE UNIQUE INDEX IF NOT EXISTS "reviews_one_prior_work_per_pair_idx"
  ON "reviews" ("reviewer_id", "subject_user_id")
  WHERE "context" = 'PRIOR_WORK' AND "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "media_derived_at_idx"
  ON "media" ("derived_at") WHERE "derived_at" IS NULL;
