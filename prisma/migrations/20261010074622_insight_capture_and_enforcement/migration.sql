-- Written to be re-runnable.
--
-- Prisma does not wrap a migration in a transaction, so a failure part-way through leaves the
-- statements before it applied — which is how this file first ran: the DDL landed and a backfill
-- below failed on a table name. Re-running a migration that is not idempotent then fails on
-- `already exists` and the only way forward is editing the database by hand. Every statement here
-- is guarded instead, so running it twice is the same as running it once.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "EnforcementSourceType" AS ENUM ('REPORT_CASE', 'FLAGGED_CONTENT', 'QUEUE_ITEM', 'MANUAL', 'GUARD_CASE', 'CONTENT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable
ALTER TABLE "user_profile" ADD COLUMN IF NOT EXISTS "arrival_set_at" TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS "country_of_origin_code" CHAR(2),
ADD COLUMN IF NOT EXISTS "first_action_at" TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS "interests_set_at" TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS "onboarding_completed_at" TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS "profile_completed_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "user_sessions" ADD COLUMN IF NOT EXISTS "app_version" TEXT,
ADD COLUMN IF NOT EXISTS "os_version" TEXT,
ADD COLUMN IF NOT EXISTS "platform" "DevicePlatform";

-- AlterTable
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_active_at" TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS "suspended_until" TIMESTAMPTZ;

-- CreateTable
CREATE TABLE IF NOT EXISTS "strikes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "reason_code" "AdminReasonCode" NOT NULL,
    "policy_subtype" TEXT,
    "note" TEXT,
    "source_type" "EnforcementSourceType" NOT NULL,
    "source_id" TEXT,
    "source_target_type" "ReportTargetType",
    "issued_by_id" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "revoked_by_id" TEXT,
    "revoke_reason" TEXT,
    "notified_at" TIMESTAMPTZ,

    CONSTRAINT "strikes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "suspensions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "starts_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ends_at" TIMESTAMPTZ,
    "reason_code" "AdminReasonCode" NOT NULL,
    "policy_subtype" TEXT,
    "note" TEXT,
    "source_type" "EnforcementSourceType" NOT NULL,
    "source_id" TEXT,
    "source_target_type" "ReportTargetType",
    "issued_by_id" TEXT NOT NULL,
    "lifted_at" TIMESTAMPTZ,
    "lifted_by_id" TEXT,
    "lift_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suspensions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "user_daily_activity" (
    "user_id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "first_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "platform" "DevicePlatform",
    "app_version" TEXT,
    "city_id" TEXT,

    CONSTRAINT "user_daily_activity_pkey" PRIMARY KEY ("user_id","day")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "strikes_user_id_expires_at_idx" ON "strikes"("user_id", "expires_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "suspensions_user_id_created_at_idx" ON "suspensions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "suspensions_lifted_at_ends_at_idx" ON "suspensions"("lifted_at", "ends_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_daily_activity_day_idx" ON "user_daily_activity"("day");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_profile_country_of_origin_code_idx" ON "user_profile"("country_of_origin_code");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "strikes" ADD CONSTRAINT "strikes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "suspensions" ADD CONSTRAINT "suspensions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "user_daily_activity" ADD CONSTRAINT "user_daily_activity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
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

-- ─── Backfills ──────────────────────────────────────────────────────────────
--
-- Every column added above answers a question about the past, and a column that starts empty
-- answers it with "nobody, ever" until enough time passes — which is worse than no chart, because
-- it looks like an answer. So each one is filled from whatever record already exists.

-- How each account came to be. The earliest social link made within five minutes of the account
-- being created is the provider it was created with; anything later is a link added afterwards by
-- somebody who signed up with an email address.
UPDATE "users" u
SET "signup_method" = COALESCE(
  (
    SELECT CASE sa."provider"::text WHEN 'GOOGLE' THEN 'GOOGLE'::"SignupMethod"
                                    WHEN 'APPLE'  THEN 'APPLE'::"SignupMethod" END
    FROM "user_social_auth" sa
    WHERE sa."user_id" = u."id"
      AND sa."created_at" BETWEEN u."created_at" - INTERVAL '5 minutes'
                              AND u."created_at" + INTERVAL '5 minutes'
    ORDER BY sa."created_at" ASC
    LIMIT 1
  ),
  'EMAIL'::"SignupMethod"
)
WHERE u."signup_method" IS NULL AND u."is_staff" = false;

-- When each member was last here. The best evidence available is the newest of their last session
-- activity and their last recorded action; it is approximate, and it is honest about being the
-- past rather than empty.
UPDATE "users" u
SET "last_active_at" = GREATEST(
  (SELECT MAX(s."last_active_at") FROM "user_sessions" s WHERE s."user_id" = u."id"),
  (SELECT MAX(a."occurred_at") FROM "activity_events" a WHERE a."user_id" = u."id")
)
WHERE u."last_active_at" IS NULL;

-- The days people were active, from the activity stream, bucketed by LONDON calendar day — which
-- is what every number in the portal is bucketed by, so building it in UTC would put a late
-- evening in the wrong day for half the year.
INSERT INTO "user_daily_activity" ("user_id", "day", "first_seen_at", "city_id")
SELECT
  a."user_id",
  (a."occurred_at" AT TIME ZONE 'Europe/London')::date AS day,
  MIN(a."occurred_at") AS first_seen_at,
  -- The city as it was recorded on the event, not the member's city now.
  (ARRAY_AGG(a."city_id" ORDER BY a."occurred_at") FILTER (WHERE a."city_id" IS NOT NULL))[1]
FROM "activity_events" a
JOIN "users" u ON u."id" = a."user_id"
WHERE a."user_id" IS NOT NULL AND u."is_staff" = false
GROUP BY a."user_id", (a."occurred_at" AT TIME ZONE 'Europe/London')::date
ON CONFLICT ("user_id", "day") DO NOTHING;

-- Members who have a session but never produced an activity event still have a day they were seen.
INSERT INTO "user_daily_activity" ("user_id", "day", "first_seen_at")
SELECT s."user_id", (s."last_active_at" AT TIME ZONE 'Europe/London')::date, MIN(s."last_active_at")
FROM "user_sessions" s
JOIN "users" u ON u."id" = s."user_id"
WHERE u."is_staff" = false
GROUP BY s."user_id", (s."last_active_at" AT TIME ZONE 'Europe/London')::date
ON CONFLICT ("user_id", "day") DO NOTHING;

-- The onboarding timestamps. There is no record of WHEN these steps happened for members who did
-- them before the columns existed, so the only honest fill is the one fact that is recorded:
-- somebody who has completed onboarding did so at or before their profile was last written.
-- Deliberately not back-dated to `createdAt`, which would invent a same-day completion for
-- everybody and make the funnel look instant.
UPDATE "user_profile"
SET "onboarding_completed_at" = "updated_at"
WHERE "onboarding_completed" = true AND "onboarding_completed_at" IS NULL;

UPDATE "user_profile"
SET "interests_set_at" = "updated_at"
WHERE "interests" IS NOT NULL AND jsonb_array_length("interests") > 0 AND "interests_set_at" IS NULL;

-- The first thing each member did that was not setting themselves up.
UPDATE "user_profile" p
SET "first_action_at" = (
  SELECT MIN(a."occurred_at")
  FROM "activity_events" a
  WHERE a."user_id" = p."user_id"
    AND a."verb"::text IN ('CREATE', 'RESPOND', 'ENQUIRE', 'BOOK')
)
WHERE p."first_action_at" IS NULL;
