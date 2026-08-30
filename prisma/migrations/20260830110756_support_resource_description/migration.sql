-- Prisma re-proposes dropping the nine trigram GIN indexes and two partial unique indexes on
-- every migration, because none of them can be expressed in the schema. The DROPs it generated
-- here were removed by hand. See 20260830110000_restore_search_and_uniqueness_indexes.

-- AlterTable
ALTER TABLE "support_resources" ADD COLUMN     "description" TEXT;
