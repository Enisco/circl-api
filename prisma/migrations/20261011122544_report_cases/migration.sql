-- Idempotent throughout: Prisma does not wrap a migration in a transaction, so one that fails
-- halfway is applied halfway, and being able to run it again is the only safe way out.
--
-- `report_cases` is §4.6's grouping table: one piece of work per target, however many people
-- reported it. Nothing reads it until §7.1's intake ships, so this migration changes no behaviour
-- on its own -- it adds a table, two enums and two nullable columns on `reports`.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ReportCasePriority" AS ENUM ('URGENT', 'HIGH', 'NORMAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ReportCaseState" AS ENUM ('OPEN', 'IN_REVIEW', 'ACTIONED', 'DISMISSED', 'ESCALATED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AlterTable
ALTER TABLE "reports" ADD COLUMN IF NOT EXISTS "case_id" TEXT;
ALTER TABLE "reports" ADD COLUMN IF NOT EXISTS "outcome_notified_at" TIMESTAMPTZ;

-- CreateTable
CREATE TABLE IF NOT EXISTS "report_cases" (
    "id" TEXT NOT NULL,
    "target_type" "ReportTargetType" NOT NULL,
    "target_id" TEXT NOT NULL,
    "target_user_id" TEXT,
    "priority" "ReportCasePriority" NOT NULL,
    "state" "ReportCaseState" NOT NULL DEFAULT 'OPEN',
    "reason_codes" "ReportReason"[],
    "report_count" INTEGER NOT NULL DEFAULT 1,
    "unique_reporter_count" INTEGER NOT NULL DEFAULT 1,
    "risk_level" "RiskLevel" NOT NULL DEFAULT 'NONE',
    "risk_score" INTEGER NOT NULL DEFAULT 0,
    "first_reported_at" TIMESTAMPTZ NOT NULL,
    "last_reported_at" TIMESTAMPTZ NOT NULL,
    "due_at" TIMESTAMPTZ NOT NULL,
    "assigned_to_id" TEXT,
    "claimed_at" TIMESTAMPTZ,
    "first_action_at" TIMESTAMPTZ,
    "decision" "ModerationDecision",
    "decision_reason_code" "AdminReasonCode",
    "policy_subtype" TEXT,
    "decision_note" TEXT,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMPTZ,
    "queue_item_id" TEXT,
    "guard_thread_id" TEXT,
    "reopened_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "report_cases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "report_cases_queue_item_id_key" ON "report_cases"("queue_item_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "report_cases_state_priority_due_at_idx" ON "report_cases"("state", "priority", "due_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "report_cases_target_type_target_id_idx" ON "report_cases"("target_type", "target_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "report_cases_target_user_id_created_at_idx" ON "report_cases"("target_user_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "report_cases_assigned_to_id_state_idx" ON "report_cases"("assigned_to_id", "state");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "reports_case_id_idx" ON "reports"("case_id");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "reports" ADD CONSTRAINT "reports_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "report_cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "report_cases" ADD CONSTRAINT "report_cases_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "report_cases" ADD CONSTRAINT "report_cases_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
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

-- One live case per target (§4.6). The grouping rule in §7.1 reads "find the open case for this
-- target, and create one only if there is none", which is a race between two reports arriving
-- together -- and two open cases about one post is two reviewers taking two decisions about it.
-- Partial, so the history of decided cases on the same target is unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS "report_cases_open_target_idx"
  ON "report_cases" ("target_type", "target_id")
  WHERE "state" IN ('OPEN', 'IN_REVIEW');
