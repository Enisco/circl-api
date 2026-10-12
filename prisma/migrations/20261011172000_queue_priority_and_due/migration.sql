
-- §5.9: the queue gains a priority and a deadline, like a report case already has.
--
-- Idempotent: Prisma does not wrap a migration in a transaction.

-- AlterTable
ALTER TABLE "moderation_queue_items" ADD COLUMN IF NOT EXISTS "due_at" TIMESTAMPTZ;
ALTER TABLE "moderation_queue_items" ADD COLUMN IF NOT EXISTS "priority" "ReportCasePriority" NOT NULL DEFAULT 'NORMAL';

-- CreateIndex
CREATE INDEX IF NOT EXISTS "moderation_queue_items_state_due_at_idx" ON "moderation_queue_items"("state", "due_at");

-- ─── Backfill ────────────────────────────────────────────────────────────────
--
-- Every item in the queue predates these columns, and a queue where nothing has a deadline sorts
-- by nothing. The priority comes from the band the scanner gave it, which is the same rule
-- `queue-priority.ts` applies to new items — written out here rather than left for the service,
-- because an existing item is never written again and would keep its default for ever.
UPDATE "moderation_queue_items"
SET "priority" = CASE
      WHEN "type" = 'GUARD_RISK' THEN 'URGENT'::"ReportCasePriority"
      WHEN "risk_level" = 'CRITICAL' THEN 'URGENT'::"ReportCasePriority"
      WHEN "risk_level" = 'HIGH' THEN 'HIGH'::"ReportCasePriority"
      ELSE 'NORMAL'::"ReportCasePriority"
    END
WHERE "priority" = 'NORMAL'
  AND ("type" = 'GUARD_RISK' OR "risk_level" IN ('CRITICAL', 'HIGH'));

-- The deadline, from `reports.slaMinutes`' defaults (60 / 240 / 1440 minutes). Wall clock for all
-- of them, including the anonymous posts: the working-hours clock lives in application code and
-- cannot be reproduced faithfully in SQL, and guessing at it here would put a deadline on a row
-- that disagrees with the one the service would compute. Wall clock is the stricter of the two, so
-- the backfill errs towards showing work as due rather than hiding it.
UPDATE "moderation_queue_items"
SET "due_at" = "created_at" + CASE "priority"
      WHEN 'URGENT' THEN INTERVAL '60 minutes'
      WHEN 'HIGH' THEN INTERVAL '240 minutes'
      ELSE INTERVAL '1440 minutes'
    END
WHERE "due_at" IS NULL;

-- Now that every row has one, the column is required. With no default and no nullability, a
-- producer that forgets a deadline is a compile error in the Prisma client rather than an item
-- that can never be overdue and sorts last in a queue ordered by urgency.
ALTER TABLE "moderation_queue_items" ALTER COLUMN "due_at" SET NOT NULL;

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
