-- Professionals v2 (circl-mobile's note of 2026-10-13).
--
-- The structural change is `category_verifications`: one record per (professional, category),
-- keyed on the **user** rather than the listing, because the professional is the person and a
-- licence check must survive a profile being rebuilt. Everything else hangs off it — a service's
-- status is derived from it rather than stored beside it.
--
-- Idempotent throughout: Prisma does not wrap a migration in a transaction, so a file that fails
-- half way is re-run from the top, and the first unguarded statement would hide the real cause.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "CategoryVerificationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'REVOKED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ServiceOwnerState" AS ENUM ('DRAFT', 'LIVE', 'HIDDEN');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "MediaRole" AS ENUM ('SHOWCASE', 'TESTIMONIAL', 'PROMO');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable
ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "role" "MediaRole";

-- AlterTable
ALTER TABLE "professional_listings" ADD COLUMN IF NOT EXISTS "custom_skills" TEXT[];

-- AlterTable
ALTER TABLE "professional_services" ADD COLUMN IF NOT EXISTS "category_code" TEXT,
ADD COLUMN IF NOT EXISTS "owner_state" "ServiceOwnerState" NOT NULL DEFAULT 'LIVE',
ADD COLUMN IF NOT EXISTS "subcategory_code" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "service_updates" (
    "id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sort" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "service_updates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "service_milestones" (
    "id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "year" INTEGER,
    "issuer" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "professional_listing_skills" (
    "listing_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "professional_listing_skills_pkey" PRIMARY KEY ("listing_id","code")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "professional_contact_hours" (
    "listing_id" TEXT NOT NULL,
    "day" "Weekday" NOT NULL,
    "open_minutes" INTEGER,
    "close_minutes" INTEGER,

    CONSTRAINT "professional_contact_hours_pkey" PRIMARY KEY ("listing_id","day")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "category_verifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "category_code" TEXT NOT NULL,
    "status" "CategoryVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "submitted_for_subcategories" TEXT[],
    "note" TEXT,
    "submitted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ,
    "decided_by_id" TEXT,
    "decision_note" TEXT,
    "licence_seen" TEXT,
    "checked_by" TEXT,
    "expires_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "category_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "service_updates_service_id_published_at_idx" ON "service_updates"("service_id", "published_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "service_milestones_service_id_sort_idx" ON "service_milestones"("service_id", "sort");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "professional_listing_skills_code_idx" ON "professional_listing_skills"("code");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "category_verifications_status_submitted_at_idx" ON "category_verifications"("status", "submitted_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "category_verifications_category_code_status_idx" ON "category_verifications"("category_code", "status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "category_verifications_user_id_category_code_key" ON "category_verifications"("user_id", "category_code");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "professional_services_listing_id_owner_state_idx" ON "professional_services"("listing_id", "owner_state");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "professional_services_category_code_subcategory_code_idx" ON "professional_services"("category_code", "subcategory_code");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "professional_services_name_trgm_idx" ON "professional_services" USING GIN ("name" gin_trgm_ops);

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "service_updates" ADD CONSTRAINT "service_updates_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "professional_services"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "service_milestones" ADD CONSTRAINT "service_milestones_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "professional_services"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "professional_listing_skills" ADD CONSTRAINT "professional_listing_skills_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "professional_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "professional_contact_hours" ADD CONSTRAINT "professional_contact_hours_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "professional_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "category_verifications" ADD CONSTRAINT "category_verifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


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
