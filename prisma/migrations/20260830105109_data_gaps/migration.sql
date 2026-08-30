-- CreateEnum
CREATE TYPE "DataExportStatus" AS ENUM ('PENDING', 'READY', 'EXPIRED', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ReportReason" ADD VALUE 'HATE_SPEECH';
ALTER TYPE "ReportReason" ADD VALUE 'NUDITY';
ALTER TYPE "ReportReason" ADD VALUE 'ILLEGAL_ITEM';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TaxonomyKind" ADD VALUE 'GENDER';
ALTER TYPE "TaxonomyKind" ADD VALUE 'MANAGED_CATEGORY';
ALTER TYPE "TaxonomyKind" ADD VALUE 'EXPERIENCE_LEVEL';
ALTER TYPE "TaxonomyKind" ADD VALUE 'URGENCY';
ALTER TYPE "TaxonomyKind" ADD VALUE 'PRIVATE_HELP_CATEGORY';
ALTER TYPE "TaxonomyKind" ADD VALUE 'CONNECT_AGE_BAND';
ALTER TYPE "TaxonomyKind" ADD VALUE 'PROFESSIONAL_SORT_OPTION';

-- CreateTable
CREATE TABLE "listing_availability" (
    "listing_id" TEXT NOT NULL,
    "day" "Weekday" NOT NULL,
    "start_minutes" INTEGER NOT NULL,
    "end_minutes" INTEGER NOT NULL,
    "slot_minutes" INTEGER NOT NULL DEFAULT 60,

    CONSTRAINT "listing_availability_pkey" PRIMARY KEY ("listing_id","day")
);

-- CreateTable
CREATE TABLE "listing_availability_blocks" (
    "id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "reason" TEXT,

    CONSTRAINT "listing_availability_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "privacy_preferences" (
    "user_id" TEXT NOT NULL,
    "personalised_feed" BOOLEAN NOT NULL DEFAULT true,
    "use_activity_for_recommendations" BOOLEAN NOT NULL DEFAULT true,
    "show_in_connect_discovery" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "privacy_preferences_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "data_export_requests" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "DataExportStatus" NOT NULL DEFAULT 'PENDING',
    "download_key" TEXT,
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ready_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ,
    "failed_at" TIMESTAMPTZ,

    CONSTRAINT "data_export_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_change_requests" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "new_email" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "confirmed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "listing_availability_blocks_listing_id_date_idx" ON "listing_availability_blocks"("listing_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "listing_availability_blocks_listing_id_date_key" ON "listing_availability_blocks"("listing_id", "date");

-- CreateIndex
CREATE INDEX "data_export_requests_user_id_requested_at_idx" ON "data_export_requests"("user_id", "requested_at");

-- CreateIndex
CREATE INDEX "email_change_requests_user_id_created_at_idx" ON "email_change_requests"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "listing_availability" ADD CONSTRAINT "listing_availability_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "professional_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_availability_blocks" ADD CONSTRAINT "listing_availability_blocks_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "professional_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "privacy_preferences" ADD CONSTRAINT "privacy_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_export_requests" ADD CONSTRAINT "data_export_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_change_requests" ADD CONSTRAINT "email_change_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
