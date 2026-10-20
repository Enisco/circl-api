-- ─── Re-runnable on purpose ──────────────────────────────────────────────────
--
-- Every statement in this file is guarded. A migration that converts a column
-- cannot be half-applied and then replayed from the top unless it is, and this
-- one failed once on an index that a previous migration had already created —
-- leaving the enum converted, the table added, and the migration marked unfinished.
-- `ALTER TYPE ... ADD VALUE` in particular cannot be undone in Postgres, so a
-- plain statement there makes the retry impossible rather than merely awkward.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ServiceRequestState" AS ENUM ('SUBMITTED', 'MATCHING', 'MATCHED', 'NO_MATCH', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ServiceRequestOfferStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'SERVICE_REQUEST';

-- AlterEnum
ALTER TYPE "ThreadContextType" ADD VALUE IF NOT EXISTS 'SERVICE_REQUEST';

-- AlterTable
ALTER TABLE "managed_briefs" ADD COLUMN IF NOT EXISTS "admin_category_code" TEXT,
ADD COLUMN IF NOT EXISTS "budget_text" TEXT,
ADD COLUMN IF NOT EXISTS "note" TEXT,
ADD COLUMN IF NOT EXISTS "outcome_by_id" TEXT,
ADD COLUMN IF NOT EXISTS "outcome_sent_at" TIMESTAMPTZ,
ALTER COLUMN "category_code" DROP NOT NULL;

-- The state column, converted rather than replaced.
--
-- `prisma migrate diff` wrote `DROP COLUMN "state"` followed by `ADD COLUMN ... DEFAULT
-- 'SUBMITTED'`, which is correct SQL for an unrelated enum and wrong for this one: every request
-- in the table would have come out of it reading "nobody has looked at this yet", including the
-- ones that had been placed. The values map, so they are mapped.
--
--   DRAFT, OPEN  → SUBMITTED   nobody has acted on it
--   MATCHED      → MATCHING    a shortlist existed; in the new words, offers are out
--   PLACED       → MATCHED     somebody took it on
--   CLOSED       → CANCELLED   it ended. Deliberately not NO_MATCH, which would claim Circl
--                              looked and found nobody — true of some of these rows and not of
--                              others, and the wrong one of those is a lie told to a member.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'managed_briefs' AND column_name = 'state' AND udt_name = 'BriefState'
  ) THEN
    ALTER TABLE "managed_briefs" ALTER COLUMN "state" DROP DEFAULT;
    ALTER TABLE "managed_briefs" ALTER COLUMN "state" TYPE "ServiceRequestState"
      USING (
        CASE "state"::text
          WHEN 'DRAFT'   THEN 'SUBMITTED'
          WHEN 'OPEN'    THEN 'SUBMITTED'
          WHEN 'MATCHED' THEN 'MATCHING'
          WHEN 'PLACED'  THEN 'MATCHED'
          WHEN 'CLOSED'  THEN 'CANCELLED'
        END
      )::"ServiceRequestState";
    ALTER TABLE "managed_briefs" ALTER COLUMN "state" SET DEFAULT 'SUBMITTED';
    ALTER TABLE "managed_briefs" ALTER COLUMN "state" SET NOT NULL;
  END IF;
END $$;

-- DropEnum
DROP TYPE IF EXISTS "BriefState";

-- CreateTable
CREATE TABLE IF NOT EXISTS "service_request_offers" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "professional_id" TEXT NOT NULL,
    "listing_id" TEXT,
    "status" "ServiceRequestOfferStatus" NOT NULL DEFAULT 'PENDING',
    "offered_by_id" TEXT NOT NULL,
    "offered_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "responded_at" TIMESTAMPTZ,
    "conversation_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "service_request_offers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "service_request_offers_professional_id_status_offered_at_idx" ON "service_request_offers"("professional_id", "status", "offered_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "service_request_offers_request_id_status_idx" ON "service_request_offers"("request_id", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "service_request_offers_status_expires_at_idx" ON "service_request_offers"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "service_request_offers_request_id_professional_id_key" ON "service_request_offers"("request_id", "professional_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "managed_briefs_state_created_at_idx" ON "managed_briefs"("state", "created_at");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "service_request_offers" ADD CONSTRAINT "service_request_offers_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "managed_briefs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "service_request_offers" ADD CONSTRAINT "service_request_offers_professional_id_fkey" FOREIGN KEY ("professional_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
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
