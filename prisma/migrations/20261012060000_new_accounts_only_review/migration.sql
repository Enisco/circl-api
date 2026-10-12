-- Professional approval applies to NEW accounts only (BACKEND-NOTES-NEW-ACCOUNTS-ONLY, 2026-10-12).
--
-- `20261011152501_listing_review` grandfathered the listings that were already live in a gated
-- profession: it set them to `PENDING` and left them visible, so staff could review them without
-- taking a trading professional offline. The portal has since settled the rule the other way, and
-- it is the better one: existing accounts are never pulled into review at all.
--
-- So this undoes that backfill. It is the only migration that can: the listings it has to find are
-- exactly the ones that are `PENDING` **and still publicly visible**, which is a state nothing
-- else produces now — a listing that genuinely needs approving is hidden while it waits.
--
-- Idempotent: Prisma does not wrap a migration in a transaction, and re-running this finds nothing
-- to do rather than failing.

-- ─── 1. The listings themselves ─────────────────────────────────────────────
--
-- Back to `NOT_REQUIRED`, which is what they were before the deploy. The submitted date goes with
-- it: a review that is no longer happening should not leave behind a date saying it started.
UPDATE "professional_listings" AS l
SET "review_state" = 'NOT_REQUIRED',
    "review_submitted_at" = NULL,
    "review_decided_at" = NULL,
    "review_decided_by_id" = NULL,
    "review_note" = NULL
WHERE l."review_state" = 'PENDING'
  AND l."deleted_at" IS NULL
  -- Visible, by the listing's own mirrored column: the grandfathered half never had its
  -- visibility touched, and every listing that properly needs approving is PENDING_APPROVAL.
  AND l."visibility_state" = 'VISIBLE';

-- ─── 2. The review items waiting on them ────────────────────────────────────
--
-- Resolved with a note rather than deleted, so a reviewer who had the item open sees why it went
-- and the trail says what happened. `NO_ACTION` because nothing was decided about the listing —
-- the rule changed underneath it.
UPDATE "moderation_queue_items" AS q
SET "state" = 'RESOLVED',
    "decision" = 'NO_ACTION',
    "decision_note" = 'Approval applies to new accounts only; this listing existed before.',
    "decided_at" = NOW()
WHERE q."type" = 'PROFESSIONAL_REVIEW'
  AND q."target_type" = 'PROFESSIONAL_LISTING'
  AND q."state" <> 'RESOLVED'
  AND EXISTS (
    SELECT 1 FROM "professional_listings" l
    WHERE l."id" = q."target_id"
      AND l."review_state" = 'NOT_REQUIRED'
      AND l."deleted_at" IS NULL
  );

-- ─── 3. Any hold this feature left on a grandfathered listing ───────────────
--
-- Belt and braces: the backfill was not supposed to hold anything, so this should find nothing.
-- Scoped to `AWAITING_APPROVAL` so a scanner's hold or a staff member's decision is untouched —
-- the same rule `ListingReviewService.release` follows, for the same reason.
UPDATE "content_safety"
SET "visibility_state" = 'VISIBLE',
    "held_reason" = NULL,
    "held_at" = NULL,
    "reviewed_at" = NULL,
    "reviewed_by_id" = NULL,
    "review_decision" = NULL
WHERE "target_type" = 'PROFESSIONAL_LISTING'
  AND "visibility_state" = 'PENDING_APPROVAL'
  AND "held_reason" = 'AWAITING_APPROVAL'
  AND EXISTS (
    SELECT 1 FROM "professional_listings" l
    WHERE l."id" = "content_safety"."target_id"
      AND l."review_state" = 'NOT_REQUIRED'
      AND l."deleted_at" IS NULL
  );
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

-- The §2.9 retention sweep's query: superseded supporting documents whose ninety days are up.
-- Partial, because the rows it wants are a handful out of every file on the platform.
--
-- Created by `20261011181827_listing_documents` and then left out of this file, which is the one
-- mistake this file exists to prevent: `migrate diff` cannot see a partial index, so the next
-- migration generated after it proposed a `DROP INDEX` for it. Caught by reading that migration
-- before applying it.
CREATE INDEX IF NOT EXISTS "media_superseded_at_idx"
  ON "media" ("superseded_at")
  WHERE "superseded_at" IS NOT NULL;

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
