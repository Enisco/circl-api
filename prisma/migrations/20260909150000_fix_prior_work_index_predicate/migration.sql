-- The index named "one prior work review per pair" was not that.
--
-- It had been restored as `WHERE booking_id IS NULL`, which makes it "one review per pair for
-- anything that is not a booking": reviewing somebody for a community request then blocked
-- reviewing them for an order, and the write failed as a 500 rather than as anything a member
-- could read. Services made it reachable, since two services with one professional are two
-- threads and two reviews.
--
-- The original definition, from 20260823152633, is the intended one.

DROP INDEX IF EXISTS "reviews_one_prior_work_per_pair_idx";

CREATE UNIQUE INDEX "reviews_one_prior_work_per_pair_idx"
  ON "reviews" ("reviewer_id", "subject_user_id")
  WHERE "context" = 'PRIOR_WORK' AND "deleted_at" IS NULL;
