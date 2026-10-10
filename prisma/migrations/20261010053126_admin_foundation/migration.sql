-- CreateEnum
CREATE TYPE "AuditArea" AS ENUM ('AUTH', 'TEAM', 'MEMBERS', 'CONTENT', 'SAFETY', 'SUPPORT', 'COMMS', 'CONFIG', 'EXPORTS', 'ANALYTICS');

-- CreateEnum
CREATE TYPE "AdminReasonCode" AS ENUM ('MEMBER_REQUEST', 'CORRECTION', 'POLICY_VIOLATION', 'SAFETY_CONCERN', 'SCAM_FRAUD', 'LEGAL_GDPR', 'OTHER');

-- CreateEnum
CREATE TYPE "SignupMethod" AS ENUM ('EMAIL', 'GOOGLE', 'APPLE');

-- CreateEnum
CREATE TYPE "AdminSessionRevokeReason" AS ENUM ('LOGOUT', 'EXPIRED', 'IDLE', 'ADMIN_REVOKED', 'DEACTIVATED', 'ROLE_CHANGED', 'CREDENTIAL_RESET', 'REFRESH_REUSE', 'SESSION_LIMIT');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "signup_method" "SignupMethod";

-- CreateTable
CREATE TABLE "admin_credentials" (
    "user_id" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "password_updated_at" TIMESTAMPTZ NOT NULL,
    "totp_secret_enc" TEXT,
    "totp_key_id" TEXT,
    "totp_enabled_at" TIMESTAMPTZ,
    "totp_last_used_step" BIGINT,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "failed_mfa_attempts" INTEGER NOT NULL DEFAULT 0,
    "lock_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ,
    "last_login_at" TIMESTAMPTZ,
    "last_login_ip" TEXT,
    "last_active_at" TIMESTAMPTZ,
    "deactivated_at" TIMESTAMPTZ,
    "deactivated_by_id" TEXT,
    "invited_by_id" TEXT,
    "credential_epoch" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "admin_credentials_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "admin_recovery_codes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "refresh_token_hash" TEXT,
    "previous_refresh_token_hash" TEXT,
    "rotated_at" TIMESTAMPTZ,
    "ip" TEXT NOT NULL,
    "user_agent" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "absolute_expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "revoked_reason" "AdminSessionRevokeReason",
    "revoked_by_id" TEXT,

    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_invites" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "invited_by_id" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "send_count" INTEGER NOT NULL DEFAULT 1,
    "last_sent_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accepted_at" TIMESTAMPTZ,
    "accepted_user_id" TEXT,
    "revoked_at" TIMESTAMPTZ,
    "revoked_by_id" TEXT,
    "staff_user_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" TEXT,
    "actor_role" TEXT,
    "actor_session_id" TEXT,
    "action" TEXT NOT NULL,
    "area" "AuditArea" NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "target_label" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason_code" "AdminReasonCode",
    "policy_subtype" TEXT,
    "reason" TEXT,
    "metadata" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,
    "idempotency_key" TEXT,
    "prev_hash" TEXT,
    "hash" TEXT,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_recovery_codes_user_id_idx" ON "admin_recovery_codes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_sessions_refresh_token_hash_key" ON "admin_sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "admin_sessions_user_id_revoked_at_idx" ON "admin_sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "admin_sessions_previous_refresh_token_hash_idx" ON "admin_sessions"("previous_refresh_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "admin_invites_token_hash_key" ON "admin_invites"("token_hash");

-- CreateIndex
CREATE INDEX "admin_invites_email_idx" ON "admin_invites"("email");

-- CreateIndex
CREATE INDEX "admin_invites_staff_user_id_idx" ON "admin_invites"("staff_user_id");

-- CreateIndex
CREATE INDEX "audit_logs_occurred_at_idx" ON "audit_logs"("occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_occurred_at_idx" ON "audit_logs"("actor_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_target_type_target_id_occurred_at_idx" ON "audit_logs"("target_type", "target_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_area_occurred_at_idx" ON "audit_logs"("area", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_action_occurred_at_idx" ON "audit_logs"("action", "occurred_at");

-- AddForeignKey
ALTER TABLE "admin_credentials" ADD CONSTRAINT "admin_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_recovery_codes" ADD CONSTRAINT "admin_recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "admin_credentials"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_invites" ADD CONSTRAINT "admin_invites_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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

-- ─── One live invite per email ──────────────────────────────────────────────
-- Partial, so an email may be invited again after the first invite was used or revoked, but never
-- have two outstanding at once: two live tokens for one address is two ways into one account.
CREATE UNIQUE INDEX IF NOT EXISTS "admin_invites_live_email_idx"
  ON "admin_invites"("email")
  WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;

-- ─── The audit trail is append-only, in the database ────────────────────────
-- Enforced here rather than by convention. An application that can rewrite its own audit log has
-- no audit log: the one row an attacker most wants to change is the one recording what they did.
-- The same rule covers moderation_actions, which is append-only by convention today.
CREATE OR REPLACE FUNCTION circl_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "audit_logs_append_only" ON "audit_logs";
CREATE TRIGGER "audit_logs_append_only"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION circl_append_only();

DROP TRIGGER IF EXISTS "moderation_actions_append_only" ON "moderation_actions";
CREATE TRIGGER "moderation_actions_append_only"
  BEFORE UPDATE OR DELETE ON "moderation_actions"
  FOR EACH ROW EXECUTE FUNCTION circl_append_only();
