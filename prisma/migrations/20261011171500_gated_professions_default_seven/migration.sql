-- §2.9: the default gated set becomes seven, and the three dropped ones let their listings go.
--
-- A deliberate change of default, not an operator decision — so it is a migration rather than
-- something left for somebody to notice. `TRADES_REPAIRS`, `EDUCATION_TUTORING` and `RECRUITMENT`
-- were gated in the first cut; the seven that remain are the ones with statutory regulation,
-- protected titles, client money or children behind them.
--
-- The second half is the part that matters. Ungating a profession without releasing the listings
-- it held leaves them `PENDING` for a review that is never coming — a hold with no release, which
-- is how content ends up invisible for ever with nobody able to say why. This mirrors
-- `ListingReviewService.release` statement for statement, and the one condition it must not get
-- wrong is "only if nothing gated is left on the listing": a listing in both `IMMIGRATION` and
-- `TRADES_REPAIRS` that loses the second still needs approving for the first, and releasing it
-- here would publish an unapproved immigration adviser.
--
-- Idempotent throughout: Prisma does not wrap a migration in a transaction, so a run that fails
-- half way has to be safe to repeat.

-- ─── 1. The flag ─────────────────────────────────────────────────────────────
-- `jsonb_set` on the one key, not a rewrite of `metadata`: `isRegulated` and `credentialBodies`
-- live in the same object and a wholesale write would take them with it.
UPDATE "taxonomy_terms"
SET "metadata" = jsonb_set(COALESCE("metadata", '{}'::jsonb), '{requiresReview}', 'false'::jsonb)
WHERE "kind" = 'PROFESSION'
  AND "code" IN ('TRADES_REPAIRS', 'EDUCATION_TUTORING', 'RECRUITMENT');

-- Belt and braces for a fresh database seeded by the new defaults, where the seven are already
-- true: this is what makes the migration idempotent rather than order-dependent.
UPDATE "taxonomy_terms"
SET "metadata" = jsonb_set(COALESCE("metadata", '{}'::jsonb), '{requiresReview}', 'true'::jsonb)
WHERE "kind" = 'PROFESSION'
  AND "code" IN (
    'IMMIGRATION', 'LEGAL', 'FINANCE_ACCOUNTING', 'HEALTHCARE', 'THERAPY_COACHING',
    'CHILDCARE_SERVICES', 'PROPERTY_LETTINGS'
  )
  AND COALESCE("metadata" -> 'requiresReview', 'null'::jsonb) IS DISTINCT FROM 'true'::jsonb;

-- ─── 2. The listings that were only waiting because of those three ───────────
CREATE TEMPORARY TABLE "released_listings" AS
SELECT l."id"
FROM "professional_listings" l
WHERE l."review_state" <> 'NOT_REQUIRED'
  AND l."deleted_at" IS NULL
  -- Nothing gated left on it.
  AND NOT EXISTS (
    SELECT 1
    FROM "professional_listing_categories" c
    JOIN "taxonomy_terms" t ON t."kind" = 'PROFESSION' AND t."code" = c."code"
    WHERE c."listing_id" = l."id"
      AND COALESCE(t."metadata" -> 'requiresReview', 'false'::jsonb) = 'true'::jsonb
  );

UPDATE "professional_listings" l
SET "review_state" = 'NOT_REQUIRED',
    "review_submitted_at" = NULL,
    "review_decided_at" = NULL,
    "review_decided_by_id" = NULL,
    "review_note" = NULL,
    -- Only a hold this feature applied. A listing a scanner held or a staff member hid stays
    -- exactly where it is: ungating a profession must not launder somebody else's hold.
    "visibility_state" = CASE
      WHEN EXISTS (
        SELECT 1 FROM "content_safety" s
        WHERE s."target_type" = 'PROFESSIONAL_LISTING' AND s."target_id" = l."id"
          AND s."visibility_state" = 'PENDING_APPROVAL' AND s."held_reason" = 'AWAITING_APPROVAL'
      ) THEN 'VISIBLE'::"ContentVisibilityState"
      ELSE l."visibility_state"
    END
FROM "released_listings" r
WHERE l."id" = r."id";

UPDATE "content_safety" s
SET "visibility_state" = 'VISIBLE',
    "held_reason" = NULL,
    "held_at" = NULL,
    "limited_at" = NULL,
    -- Cleared with the hold, and this is the subtle half: `reviewed_by_id` is one of the two things
    -- that makes a later re-scan refuse to publish a row (§6.6). A decline's reviewer left behind
    -- on a released listing would have the next scan of it pull the listing back out of reach.
    "reviewed_at" = NULL,
    "reviewed_by_id" = NULL,
    "review_decision" = NULL
FROM "released_listings" r
WHERE s."target_type" = 'PROFESSIONAL_LISTING'
  AND s."target_id" = r."id"
  AND s."visibility_state" = 'PENDING_APPROVAL'
  AND s."held_reason" = 'AWAITING_APPROVAL';

UPDATE "moderation_queue_items" q
SET "state" = 'RESOLVED',
    "decision" = 'NO_ACTION',
    "decision_note" = 'No longer in a profession that needs approving.',
    "decided_at" = NOW()
FROM "released_listings" r
WHERE q."type" = 'PROFESSIONAL_REVIEW'
  AND q."target_type" = 'PROFESSIONAL_LISTING'
  AND q."target_id" = r."id"
  AND q."state" <> 'RESOLVED';

DROP TABLE "released_listings";

-- ─── 3. The version stamp ────────────────────────────────────────────────────
-- Invalidates every process's taxonomy cache and the clients' ETag. Without it the app keeps
-- warning members about a profession that is no longer gated.
UPDATE "taxonomy_version" SET "version" = NOW() WHERE "id" = 'SINGLETON';
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

-- What the derivation sweep reads to find the media it has not measured yet. Partial, because the
-- rows it wants are the ones with no measurement, and without it that is a scan of the whole table
-- every hour.
CREATE INDEX IF NOT EXISTS "media_derived_at_idx"
  ON "media" ("derived_at")
  WHERE "derived_at" IS NULL;

-- "One per pair, ever" for prior-work reviews (2.5.2). The table's own unique key
-- is (reviewer_id, context, source_id), and prior-work carries no source —
-- Postgres treats those NULLs as distinct, so it needs its own index.
CREATE UNIQUE INDEX IF NOT EXISTS "reviews_one_prior_work_per_pair_idx"
  ON "reviews" ("reviewer_id", "subject_user_id")
  WHERE "context" = 'PRIOR_WORK' AND "deleted_at" IS NULL;

-- One live invitation per email address. Partial, so an address may be invited again once the
-- first invite was used or revoked, but never have two outstanding at the same time: two live
-- tokens for one staff account are two ways into it, and the second would outlive whatever made
-- the first one suspect.
CREATE UNIQUE INDEX IF NOT EXISTS "admin_invites_live_email_idx"
  ON "admin_invites" ("email")
  WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;

-- The filter bar asks "which builds are still in the wild" every ten minutes, and that is a
-- DISTINCT over every session row. Leading on the two projected columns so the DISTINCT comes free
-- from index order rather than a sort, and partial because a session with no recorded build is not
-- an answer -- which also keeps the index to the rows the query wants. Sessions grow as members
-- times devices, so this is a sequential scan that gets slower every week it is left alone.
CREATE INDEX IF NOT EXISTS "user_sessions_app_version_idx"
  ON "user_sessions" ("app_version", "platform", "last_active_at")
  WHERE "app_version" IS NOT NULL;

-- One live case per target (§4.6). The grouping rule in §7.1 reads "find the open case for this
-- target, and create one only if there is none", which is a race between two reports arriving
-- together -- and two open cases about one post is two reviewers taking two decisions about it.
-- Partial, so the history of decided cases on the same target is unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS "report_cases_open_target_idx"
  ON "report_cases" ("target_type", "target_id")
  WHERE "state" IN ('OPEN', 'IN_REVIEW');
