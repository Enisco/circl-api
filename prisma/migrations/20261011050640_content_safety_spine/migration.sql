-- Idempotent throughout: Prisma does not wrap a migration in a transaction, so a migration that
-- fails halfway is applied halfway and the only safe way out is to be able to run it again.
--
-- Every column added here defaults to VISIBLE, so nothing changes for anybody until the scanner
-- that writes the other states ships. That is deliberate: the read paths start filtering on a
-- column whose value is the same for every existing row, which is a change that can be deployed
-- and measured before it can hide anything.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ContentRiskTier" AS ENUM ('CLEAN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ContentVisibilityState" AS ENUM ('VISIBLE', 'LIMITED', 'HELD', 'PENDING_APPROVAL', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ContentScanStatus" AS ENUM ('PENDING', 'COMPLETE', 'DEGRADED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ContentScanTrigger" AS ENUM ('CREATE', 'EDIT', 'RESCAN', 'REPORT', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "RiskTermHitOutcome" AS ENUM ('PENDING', 'CONFIRMED', 'FALSE_POSITIVE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AlterTable
ALTER TABLE "community_offers" ADD COLUMN IF NOT EXISTS "visibility_state" "ContentVisibilityState" NOT NULL DEFAULT 'VISIBLE';

-- AlterTable
ALTER TABLE "community_requests" ADD COLUMN IF NOT EXISTS "visibility_state" "ContentVisibilityState" NOT NULL DEFAULT 'VISIBLE';

-- AlterTable
ALTER TABLE "community_updates" ADD COLUMN IF NOT EXISTS "visibility_state" "ContentVisibilityState" NOT NULL DEFAULT 'VISIBLE';

-- AlterTable
ALTER TABLE "connect_posts" ADD COLUMN IF NOT EXISTS "visibility_state" "ContentVisibilityState" NOT NULL DEFAULT 'VISIBLE';

-- AlterTable
ALTER TABLE "connect_profiles" ADD COLUMN IF NOT EXISTS "visibility_state" "ContentVisibilityState" NOT NULL DEFAULT 'VISIBLE';

-- AlterTable
ALTER TABLE "connect_stories" ADD COLUMN IF NOT EXISTS "visibility_state" "ContentVisibilityState" NOT NULL DEFAULT 'VISIBLE';

-- AlterTable
ALTER TABLE "group_post_replies" ADD COLUMN IF NOT EXISTS "visibility_state" "ContentVisibilityState" NOT NULL DEFAULT 'VISIBLE';

-- AlterTable
ALTER TABLE "group_posts" ADD COLUMN IF NOT EXISTS "visibility_state" "ContentVisibilityState" NOT NULL DEFAULT 'VISIBLE';

-- AlterTable
ALTER TABLE "groups" ADD COLUMN IF NOT EXISTS "visibility_state" "ContentVisibilityState" NOT NULL DEFAULT 'VISIBLE';

-- AlterTable
ALTER TABLE "guides" ADD COLUMN IF NOT EXISTS "visibility_state" "ContentVisibilityState" NOT NULL DEFAULT 'VISIBLE';

-- AlterTable
ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "moderation_state" "ContentVisibilityState" NOT NULL DEFAULT 'VISIBLE';

-- AlterTable
ALTER TABLE "professional_listings" ADD COLUMN IF NOT EXISTS "visibility_state" "ContentVisibilityState" NOT NULL DEFAULT 'VISIBLE';

-- AlterTable
ALTER TABLE "professional_services" ADD COLUMN IF NOT EXISTS "visibility_state" "ContentVisibilityState" NOT NULL DEFAULT 'VISIBLE';

-- AlterTable
ALTER TABLE "request_responses" ADD COLUMN IF NOT EXISTS "visibility_state" "ContentVisibilityState" NOT NULL DEFAULT 'VISIBLE';

-- AlterTable
ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "visibility_state" "ContentVisibilityState" NOT NULL DEFAULT 'VISIBLE';

-- AlterTable
ALTER TABLE "risk_terms" ADD COLUMN IF NOT EXISTS "confirmed_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "created_by_id" TEXT,
ADD COLUMN IF NOT EXISTS "false_positive_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "hit_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "last_hit_at" TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS "updated_by_id" TEXT;

-- AlterTable
ALTER TABLE "store_items" ADD COLUMN IF NOT EXISTS "visibility_state" "ContentVisibilityState" NOT NULL DEFAULT 'VISIBLE';

-- AlterTable
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "visibility_state" "ContentVisibilityState" NOT NULL DEFAULT 'VISIBLE';

-- AlterTable
ALTER TABLE "update_replies" ADD COLUMN IF NOT EXISTS "visibility_state" "ContentVisibilityState" NOT NULL DEFAULT 'VISIBLE';

-- AlterTable
ALTER TABLE "user_profile" ADD COLUMN IF NOT EXISTS "bio_visibility_state" "ContentVisibilityState" NOT NULL DEFAULT 'VISIBLE';

-- CreateTable
CREATE TABLE IF NOT EXISTS "content_safety" (
    "id" TEXT NOT NULL,
    "target_type" "ReportTargetType" NOT NULL,
    "target_id" TEXT NOT NULL,
    "author_id" TEXT,
    "tier" "ContentRiskTier" NOT NULL DEFAULT 'CLEAN',
    "visibility_state" "ContentVisibilityState" NOT NULL DEFAULT 'VISIBLE',
    "final_score" INTEGER NOT NULL DEFAULT 0,
    "lexicon_score" INTEGER NOT NULL DEFAULT 0,
    "lexicon_signals" JSONB,
    "classifier_scores" JSONB,
    "classifier_flagged" BOOLEAN,
    "category" "RiskCategory",
    "scan_status" "ContentScanStatus" NOT NULL DEFAULT 'PENDING',
    "scan_version" INTEGER NOT NULL DEFAULT 0,
    "content_hash" TEXT,
    "held_at" TIMESTAMPTZ,
    "held_reason" TEXT,
    "limited_at" TIMESTAMPTZ,
    "reviewed_at" TIMESTAMPTZ,
    "reviewed_by_id" TEXT,
    "review_decision" "ModerationDecision",
    "guard_thread_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "content_safety_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "content_scans" (
    "id" TEXT NOT NULL,
    "content_safety_id" TEXT NOT NULL,
    "trigger" "ContentScanTrigger" NOT NULL,
    "scan_version" INTEGER NOT NULL,
    "content_hash" TEXT NOT NULL,
    "lexicon_score" INTEGER NOT NULL,
    "lexicon_signals" JSONB,
    "classifier_model" TEXT,
    "classifier_scores" JSONB,
    "classifier_error" TEXT,
    "final_score" INTEGER NOT NULL,
    "tier" "ContentRiskTier" NOT NULL,
    "degraded" BOOLEAN NOT NULL DEFAULT false,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "risk_term_hits" (
    "id" TEXT NOT NULL,
    "risk_term_id" TEXT NOT NULL,
    "content_safety_id" TEXT,
    "target_type" "ReportTargetType" NOT NULL,
    "target_id" TEXT NOT NULL,
    "outcome" "RiskTermHitOutcome" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ,

    CONSTRAINT "risk_term_hits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "content_safety_visibility_state_tier_created_at_idx" ON "content_safety"("visibility_state", "tier", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "content_safety_author_id_created_at_idx" ON "content_safety"("author_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "content_safety_target_type_target_id_key" ON "content_safety"("target_type", "target_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "content_scans_content_safety_id_created_at_idx" ON "content_scans"("content_safety_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "risk_term_hits_risk_term_id_created_at_idx" ON "risk_term_hits"("risk_term_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "risk_term_hits_risk_term_id_outcome_idx" ON "risk_term_hits"("risk_term_id", "outcome");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "risk_term_hits_target_type_target_id_idx" ON "risk_term_hits"("target_type", "target_id");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "content_scans" ADD CONSTRAINT "content_scans_content_safety_id_fkey" FOREIGN KEY ("content_safety_id") REFERENCES "content_safety"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "risk_term_hits" ADD CONSTRAINT "risk_term_hits_risk_term_id_fkey" FOREIGN KEY ("risk_term_id") REFERENCES "risk_terms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "risk_term_hits" ADD CONSTRAINT "risk_term_hits_content_safety_id_fkey" FOREIGN KEY ("content_safety_id") REFERENCES "content_safety"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

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
