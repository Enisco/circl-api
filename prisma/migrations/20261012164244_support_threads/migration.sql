-- §4.8's support inbox: the staff side of a support conversation, and the canned replies.
--
-- New enum *types*, so they may be used in the migration that creates them — unlike a new value on
-- an existing enum, which Postgres refuses to use in the same transaction (55P04).
--
-- Idempotent throughout: Prisma does not wrap a migration in a transaction, so a failure halfway
-- leaves everything before it applied and this file replayed over the top.
DO $$ BEGIN
  CREATE TYPE "SupportThreadType" AS ENUM ('SUPPORT', 'MANAGED', 'DISPUTE', 'GUARD', 'DEAL_PROBLEM');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "SupportThreadState" AS ENUM ('NEW', 'OPEN', 'WAITING_ON_MEMBER', 'RESOLVED', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "support_threads" (
    "conversation_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "type" "SupportThreadType" NOT NULL,
    "state" "SupportThreadState" NOT NULL DEFAULT 'NEW',
    "assigned_to_id" TEXT,
    "assigned_at" TIMESTAMPTZ,
    "first_member_message_at" TIMESTAMPTZ,
    "first_response_at" TIMESTAMPTZ,
    "last_member_message_at" TIMESTAMPTZ,
    "last_staff_message_at" TIMESTAMPTZ,
    "resolved_at" TIMESTAMPTZ,
    "reopen_count" INTEGER NOT NULL DEFAULT 0,
    "tags" TEXT[],
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "support_threads_pkey" PRIMARY KEY ("conversation_id")
);

CREATE TABLE IF NOT EXISTS "canned_replies" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "canned_replies_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "support_threads_state_assigned_to_id_last_member_message_at_idx" ON "support_threads"("state", "assigned_to_id", "last_member_message_at");
CREATE INDEX IF NOT EXISTS "support_threads_member_id_idx" ON "support_threads"("member_id");
CREATE INDEX IF NOT EXISTS "canned_replies_is_active_title_idx" ON "canned_replies"("is_active", "title");

DO $$ BEGIN
  ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_member_id_fkey"
    FOREIGN KEY ("member_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill: every support conversation that already exists gets its staff row.
--
-- Without this the inbox opens empty on a platform that already has support conversations in it,
-- and the first member to write into an old thread would create its row with a `created_at` of
-- today -- so the oldest thread on the platform would sort as the newest.
--
-- `ON CONFLICT DO NOTHING` rather than an upsert, deliberately: replayed after the hooks have
-- started writing, this must not overwrite a live row with a reconstruction of it.
-- ─────────────────────────────────────────────────────────────────────────────
WITH msgs AS (
  -- Real messages only. A SYSTEM message has no sender and is not an answer to anybody (§7.6),
  -- so counting one as a staff reply would give a thread a response time it never had.
  SELECT m."conversation_id", m."sent_at", p."role"
  FROM "messages" m
  JOIN "conversations" c ON c."id" = m."conversation_id" AND c."kind" = 'SUPPORT'
  JOIN "conversation_participants" p
    ON p."conversation_id" = m."conversation_id" AND p."user_id" = m."sender_id"
  WHERE m."sender_id" IS NOT NULL AND m."kind" <> 'SYSTEM'
),
agg AS (
  SELECT "conversation_id",
         MIN("sent_at") FILTER (WHERE "role" = 'MEMBER') AS first_member,
         MAX("sent_at") FILTER (WHERE "role" = 'MEMBER') AS last_member,
         MAX("sent_at") FILTER (WHERE "role" = 'STAFF')  AS last_staff
  FROM msgs
  GROUP BY 1
),
resp AS (
  -- The first staff message **after** the first member message. A thread Circl opened and the
  -- member has not replied to has no response time rather than a negative one.
  SELECT a."conversation_id", MIN(m."sent_at") AS first_response
  FROM agg a
  JOIN msgs m ON m."conversation_id" = a."conversation_id"
  WHERE m."role" = 'STAFF' AND a.first_member IS NOT NULL AND m."sent_at" > a.first_member
  GROUP BY 1
)
INSERT INTO "support_threads" (
  "conversation_id", "member_id", "type", "state",
  "first_member_message_at", "first_response_at", "last_member_message_at", "last_staff_message_at",
  "tags", "created_at", "updated_at"
)
SELECT
  c."id",
  -- Exactly one MEMBER participant on a support conversation: every creator passes a single id in
  -- `participantIds` and the staff go in as STAFF. A conversation with none is skipped by the join
  -- rather than backfilled with a guess.
  (SELECT p."user_id" FROM "conversation_participants" p
    WHERE p."conversation_id" = c."id" AND p."role" = 'MEMBER' LIMIT 1),
  CASE
    -- Guard first, and that order is the point rather than a tidiness: a Guard disclosure and a
    -- deal problem are both `context_type = 'SUPPORT'` with a null context id, so they are the
    -- *same* conversation for a member who has had both (D36). Typed anything but GUARD, §5.15
    -- would list it in the support inbox for staff without `guard:read`.
    WHEN EXISTS (SELECT 1 FROM "guard_threads" g WHERE g."conversation_id" = c."id") THEN 'GUARD'
    WHEN c."context_type" IN ('MANAGED_REQUEST', 'BRIEF') THEN 'MANAGED'
    WHEN c."context_type" = 'DISPUTE' THEN 'DISPUTE'
    ELSE 'SUPPORT'
  END::"SupportThreadType",
  CASE
    -- NEW means nobody has answered yet, which is not the same as OPEN (§7.6).
    WHEN a.last_staff IS NULL THEN 'NEW'
    WHEN a.last_member IS NOT NULL AND a.last_member > a.last_staff THEN 'OPEN'
    ELSE 'WAITING_ON_MEMBER'
  END::"SupportThreadState",
  a.first_member,
  r.first_response,
  a.last_member,
  a.last_staff,
  '{}'::text[],
  c."created_at",
  NOW()
FROM "conversations" c
LEFT JOIN agg a ON a."conversation_id" = c."id"
LEFT JOIN resp r ON r."conversation_id" = c."id"
WHERE c."kind" = 'SUPPORT'
  AND EXISTS (
    SELECT 1 FROM "conversation_participants" p
    WHERE p."conversation_id" = c."id" AND p."role" = 'MEMBER'
  )
ON CONFLICT ("conversation_id") DO NOTHING;

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
