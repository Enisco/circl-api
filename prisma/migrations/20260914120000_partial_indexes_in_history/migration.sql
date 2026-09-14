-- The three indexes a Prisma schema cannot describe, put into the history where they belong.
--
-- They were created at boot by `assertInvisibleIndexes` and by nothing else, so replaying the
-- migrations produced a database without them while the real one had them. That difference is what
-- `migrate dev` reports as drift, and drift is what makes it offer to reset the schema — offered
-- four times, each answered by another "restore the partial indexes" migration that the next run
-- dropped again. A fresh `migrate deploy` also ended up without them until something booted.
--
-- scripts/new-migration.sh keeps them out of generated migrations; this puts them into the history
-- once so a database built from it is correct on its own.

-- One help offer per author per request (1.3.2). A member may reply many times and offer once.
--
-- The predicate gains `deleted_at IS NULL`. The live index had only `is_help_offer = true`, which
-- made the rule "one offer ever": a member who deleted their offer could never make another, and
-- the only sign of it was a constraint violation on a request they appeared not to have offered on.
-- Narrowing which rows are indexed can never fail on existing data.
DROP INDEX IF EXISTS "request_responses_one_offer_per_author_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "request_responses_one_offer_per_author_idx"
  ON "request_responses" ("request_id", "author_id")
  WHERE "is_help_offer" AND "deleted_at" IS NULL;

-- What the derivation sweep reads to find media it has not measured yet. Without it that is a scan
-- of the whole table, every hour.
CREATE INDEX IF NOT EXISTS "media_derived_at_idx"
  ON "media" ("derived_at")
  WHERE "derived_at" IS NULL;

-- One prior-work review per pair (2.5.2), counting only the ones that still exist.
CREATE UNIQUE INDEX IF NOT EXISTS "reviews_one_prior_work_per_pair_idx"
  ON "reviews" ("reviewer_id", "subject_user_id")
  WHERE "context" = 'PRIOR_WORK' AND "deleted_at" IS NULL;
