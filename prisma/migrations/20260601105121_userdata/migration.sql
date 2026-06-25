/*
  Warnings:

  - You are about to drop the column `additional_info` on the `user_profile` table. All the data in the column will be lost.
  - You are about to drop the column `avatar` on the `user_profile` table. All the data in the column will be lost.
  - You are about to drop the column `date_of_birth` on the `user_profile` table. All the data in the column will be lost.
  - You are about to drop the column `unit_preference` on the `user_profile` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[username]` on the table `users` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
ALTER TYPE "Gender" ADD VALUE 'NON_BINARY';

-- AlterTable
ALTER TABLE "user_notification_prefs" ADD COLUMN     "connection_requests" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "group_activity" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "new_messages" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "new_offers_on_my_requests" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "platform_updates" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "user_profile" DROP COLUMN "additional_info",
DROP COLUMN "avatar",
DROP COLUMN "date_of_birth",
DROP COLUMN "unit_preference",
ADD COLUMN     "bio" TEXT,
ADD COLUMN     "can_help_with" TEXT,
ADD COLUMN     "city_id" TEXT,
ADD COLUMN     "country_of_origin" TEXT,
ADD COLUMN     "open_inbox" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "username" TEXT;

-- DropEnum
DROP TYPE "ExperienceLevel";

-- DropEnum
DROP TYPE "UnitPreference";

-- CreateTable
CREATE TABLE "cities" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "cities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_profile_city_id_idx" ON "user_profile"("city_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_username_idx" ON "users"("username");

-- AddForeignKey
ALTER TABLE "user_profile" ADD CONSTRAINT "user_profile_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
