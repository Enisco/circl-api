-- DropIndex
DROP INDEX "community_offers_title_trgm_idx";

-- DropIndex
DROP INDEX "community_requests_title_trgm_idx";

-- DropIndex
DROP INDEX "groups_name_trgm_idx";

-- DropIndex
DROP INDEX "guides_intro_trgm_idx";

-- DropIndex
DROP INDEX "guides_title_trgm_idx";

-- DropIndex
DROP INDEX "professional_listings_title_trgm_idx";

-- DropIndex
DROP INDEX "request_responses_request_id_author_id_is_help_offer_key";

-- DropIndex
DROP INDEX "store_items_name_trgm_idx";

-- DropIndex
DROP INDEX "stores_name_trgm_idx";

-- CreateIndex
CREATE INDEX "request_responses_request_id_author_id_idx" ON "request_responses"("request_id", "author_id");

-- ─── Partial unique indexes Prisma cannot express ────────────────────────────
-- A member may post several plain replies to a request but only ONE help offer
-- (1.3.2), which is what keeps `helper_count` equal to the number of distinct
-- people. A plain UNIQUE over (request_id, author_id, is_help_offer) would also
-- block the second plain reply, so the constraint is scoped to the offers.
CREATE UNIQUE INDEX "request_responses_one_offer_per_author_idx"
  ON "request_responses" ("request_id", "author_id")
  WHERE "is_help_offer" AND "deleted_at" IS NULL;

-- "One per pair, ever" for prior-work reviews (2.5.2). The table's own unique
-- key is (reviewer_id, context, source_id), and prior-work carries no source —
-- Postgres treats those NULLs as distinct, so it needs its own index.
CREATE UNIQUE INDEX "reviews_one_prior_work_per_pair_idx"
  ON "reviews" ("reviewer_id", "subject_user_id")
  WHERE "context" = 'PRIOR_WORK' AND "deleted_at" IS NULL;
