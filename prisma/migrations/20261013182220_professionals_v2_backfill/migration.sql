-- Professionals v2: the data half (v2 §7, §10).
--
-- Four changes to what is already stored, none of which the schema can express. Every one is
-- idempotent and re-runnable, because Prisma does not wrap a migration in a transaction.

-- ─── 1. The listing review stops being the sell gate (§7) ────────────────────
--
-- `requiresReview` meant "a human reads documents before this *listing* goes anywhere". That
-- question is now asked per `(professional, category)` instead, and asking it in both places would
-- refuse a member at registration for work they have not offered yet — which is exactly what it
-- did to a live listing the moment v2's taxonomy landed.
--
-- The flag is **operator-owned**: the seeder deliberately never overwrites it, so a gate staff
-- turned on survives a deploy. That is right, and it is why this has to be a migration: the only
-- thing allowed to change an operator's value is a one-off, deliberate statement like this one.
--
-- The listing review object, its endpoints and its history are kept. Nothing is deleted here.
UPDATE "taxonomy_terms"
SET "metadata" = jsonb_set(COALESCE("metadata", '{}'::jsonb), '{requiresReview}', 'false'::jsonb)
WHERE "kind" = 'PROFESSION'
  AND COALESCE("metadata" -> 'requiresReview', 'false'::jsonb) = 'true'::jsonb;

-- Every running instance has to notice. `TaxonomyService` caches the whole vocabulary in memory
-- and re-reads it only when this row's timestamp moves, so a migration that rewrote the terms
-- without touching it would leave the old gates in force until the next deploy — which is the one
-- failure nobody would look for, because the rows in the database would be right.
UPDATE "taxonomy_version" SET "version" = NOW() WHERE "id" = 'SINGLETON';

-- ─── 2. Categories whose work is now a subcategory (§3.3) ───────────────────
--
-- Seven of the twenty-one existing categories are covered by a subcategory of one of v2's
-- fourteen: *Cleaning* is `TRADES_CLEANER`, *Childcare* is `EDUCATION_CHILDCARE`, and so on.
-- Leaving them active would mean two routes to the same work and a search split between them.
--
-- Retired rather than deleted, which is the contract (§8): a listing that already holds one keeps
-- rendering its label, and nobody is offered it again. `isActive` is set only here for the same
-- reason as the flag above — the portal owns it from now on.
UPDATE "taxonomy_terms"
SET "is_active" = false
WHERE "kind" = 'PROFESSION'
  AND "code" IN (
    'THERAPY_COACHING',
    'CHILDCARE_SERVICES',
    'RECRUITMENT',
    'DESIGN_CREATIVE',
    'MARKETING',
    'PHOTOGRAPHY_VIDEO',
    'CLEANING'
  );

-- ─── 3. Existing services get a category (§10) ──────────────────────────────
--
-- From the listing's **primary** category, which is what the client would have shown beside the
-- service anyway. `description` and `price` are left as they are: required on create, nullable on
-- read, because a service written before v2 has neither and rendering it without is better than
-- hiding somebody's live work.
--
-- No subcategory is invented. A legacy service sits directly under its category, which is a state
-- the gate rule already handles: a service with no subcategory is gated by its category, and none
-- of the fourteen categories is gated.
UPDATE "professional_services" AS s
SET "category_code" = c."code"
FROM "professional_listing_categories" AS c
WHERE c."listing_id" = s."listing_id"
  AND c."is_primary" = true
  AND s."category_code" IS NULL;

-- And where no category is flagged primary, any of the listing's own — alphabetically, so a
-- re-run picks the same one. A listing is created with one to three categories and the first is
-- flagged, but a listing that predates that flag has three unflagged rows and its services would
-- otherwise keep no category at all. A service with none is still legal — it renders without the
-- line and is gated by nothing — so this is about being useful rather than about correctness.
UPDATE "professional_services" AS s
SET "category_code" = (
  SELECT c."code"
  FROM "professional_listing_categories" AS c
  WHERE c."listing_id" = s."listing_id"
  ORDER BY c."code" ASC
  LIMIT 1
)
WHERE s."category_code" IS NULL
  AND EXISTS (
    SELECT 1 FROM "professional_listing_categories" AS c WHERE c."listing_id" = s."listing_id"
  );

-- `owner_state` from the column it replaces (§5.5.1). `isActive` meant "not hidden", which is the
-- owner's intent and nothing else — so a paused service becomes `HIDDEN` and the rest `LIVE`.
UPDATE "professional_services"
SET "owner_state" = 'HIDDEN'
WHERE "is_active" = false
  AND "owner_state" = 'LIVE';

-- ─── 4. Approved listing reviews become approved verifications (§7) ─────────
--
-- **Nobody who has already been through a review is asked to do it again.** That is the one
-- migration failure members would notice, and it is the reason this runs here rather than being
-- left to the first time somebody tries to sell something.
--
-- One record per gated category the listing holds, carrying the original decision's date and the
-- note the member was shown. `ON CONFLICT DO NOTHING` makes it re-runnable and makes it safe to
-- run after somebody has already submitted something newer by hand.
INSERT INTO "category_verifications" (
  "id",
  "user_id",
  "category_code",
  "status",
  "submitted_for_subcategories",
  "note",
  "submitted_at",
  "decided_at",
  "decided_by_id",
  "decision_note",
  "checked_by",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid(),
  l."user_id",
  c."code",
  'APPROVED',
  ARRAY[]::text[],
  'Carried over from the profile review approved on ' ||
    to_char(COALESCE(l."review_decided_at", l."updated_at"), 'FMDD FMMonth YYYY') || '.',
  COALESCE(l."review_submitted_at", l."created_at"),
  COALESCE(l."review_decided_at", l."updated_at"),
  l."review_decided_by_id",
  l."review_note",
  'Circl Trust & Safety',
  NOW(),
  NOW()
FROM "professional_listings" AS l
JOIN "professional_listing_categories" AS c ON c."listing_id" = l."id"
JOIN "taxonomy_terms" AS t ON t."kind" = 'PROFESSION' AND t."code" = c."code"
WHERE l."review_state" = 'APPROVED'
  AND l."deleted_at" IS NULL
  -- Only where the category is one somebody now needs verifying for: a gate on the category
  -- itself, or on any of its children. An approval for ungated work would be a badge nobody
  -- earned.
  AND (
    COALESCE(t."metadata" -> 'requiresVerification', 'false'::jsonb) = 'true'::jsonb
    OR EXISTS (
      SELECT 1
      FROM "taxonomy_terms" AS child
      WHERE child."kind" = 'PROFESSION_SUBCATEGORY'
        AND child."metadata" ->> 'parentCode' = c."code"
        AND COALESCE(child."metadata" -> 'requiresVerification', 'false'::jsonb) = 'true'::jsonb
    )
  )
ON CONFLICT ("user_id", "category_code") DO NOTHING;

-- The documents that approval rested on follow it, for the listing's **primary** category.
--
-- Re-pointed rather than copied: the same bytes under two owners would be two retention clocks and
-- two chances to delete the wrong one. The listing review keeps its decision, its dates and its
-- note; what moves is the evidence, to the record that now carries the approval.
--
-- Only the primary category, because a file can have one owner and the review was predominantly
-- about the work the listing leads with. A professional approved for two gated categories gets the
-- second record with no documents attached, which reads correctly: the approval stands, and the
-- paperwork is filed under the first.
UPDATE "media" AS m
SET "owner_type" = 'CATEGORY_VERIFICATION', "owner_id" = v."id"
FROM "professional_listings" AS l
JOIN "professional_listing_categories" AS c
  ON c."listing_id" = l."id" AND c."is_primary" = true
JOIN "category_verifications" AS v
  ON v."user_id" = l."user_id" AND v."category_code" = c."code"
WHERE m."owner_type" = 'LISTING_DOCUMENT'
  AND m."owner_id" = l."id"
  AND m."superseded_at" IS NULL
  AND v."status" = 'APPROVED';
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
