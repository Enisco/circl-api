-- DropIndex stanzas removed by hand: the nine trigram GIN indexes and two partial uniques
-- cannot be expressed in the schema, so Prisma re-proposes dropping them every migration.
-- test/e2e/schema-indexes.e2e.cjs guards this.

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationKind" ADD VALUE 'LIKE';
ALTER TYPE "NotificationKind" ADD VALUE 'BOOKMARK';
