-- CreateEnum
CREATE TYPE "ConnectAccent" AS ENUM ('BLUE', 'GREEN', 'TEAL', 'VIOLET', 'AMBER', 'ROSE', 'SLATE', 'FOREST', 'INDIGO', 'SKY', 'PLUM', 'CRIMSON', 'RUST', 'OLIVE', 'NAVY', 'PINE');

-- CreateEnum
CREATE TYPE "ConnectPostKind" AS ENUM ('PHOTO', 'VIDEO');

-- CreateEnum
CREATE TYPE "ConnectAboutKind" AS ENUM ('MEDIA', 'PROMPT');

-- AlterEnum
ALTER TYPE "MediaPurpose" ADD VALUE 'CONNECT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ReportTargetType" ADD VALUE 'CONNECT_MEDIA';
ALTER TYPE "ReportTargetType" ADD VALUE 'CONNECT_STORY';

-- AlterEnum
ALTER TYPE "TaxonomyKind" ADD VALUE 'CONNECT_PROMPT';

-- AlterTable
ALTER TABLE "connect_profiles" ADD COLUMN     "accent_colour" "ConnectAccent";

-- AlterTable
ALTER TABLE "connection_requests" ADD COLUMN     "about_id" TEXT,
ADD COLUMN     "about_kind" "ConnectAboutKind";

-- CreateTable
CREATE TABLE "connect_posts" (
    "id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "kind" "ConnectPostKind" NOT NULL,
    "caption" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "report_token" TEXT NOT NULL,
    "posted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "connect_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connect_prompt_answers" (
    "profile_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "connect_prompt_answers_pkey" PRIMARY KEY ("profile_id","code")
);

-- CreateTable
CREATE TABLE "connect_stories" (
    "id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "report_token" TEXT NOT NULL,
    "posted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "connect_stories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connect_story_seen" (
    "story_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connect_story_seen_pkey" PRIMARY KEY ("story_id","user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "connect_posts_report_token_key" ON "connect_posts"("report_token");

-- CreateIndex
CREATE INDEX "connect_posts_profile_id_position_idx" ON "connect_posts"("profile_id", "position");

-- CreateIndex
CREATE INDEX "connect_prompt_answers_profile_id_position_idx" ON "connect_prompt_answers"("profile_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "connect_stories_report_token_key" ON "connect_stories"("report_token");

-- CreateIndex
CREATE INDEX "connect_stories_profile_id_posted_at_idx" ON "connect_stories"("profile_id", "posted_at");

-- CreateIndex
CREATE INDEX "connect_stories_expires_at_idx" ON "connect_stories"("expires_at");

-- CreateIndex
CREATE INDEX "connect_story_seen_user_id_idx" ON "connect_story_seen"("user_id");

-- AddForeignKey
ALTER TABLE "connect_posts" ADD CONSTRAINT "connect_posts_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "connect_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connect_prompt_answers" ADD CONSTRAINT "connect_prompt_answers_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "connect_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connect_stories" ADD CONSTRAINT "connect_stories_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "connect_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connect_story_seen" ADD CONSTRAINT "connect_story_seen_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "connect_stories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connect_story_seen" ADD CONSTRAINT "connect_story_seen_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
