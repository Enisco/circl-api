-- The DropIndex stanzas Prisma generated here were removed by hand: the nine trigram GIN
-- indexes and two partial uniques cannot be expressed in the schema, so it re-proposes
-- dropping them on every migration. test/e2e/schema-indexes.e2e.cjs guards this.

-- AlterTable
ALTER TABLE "stores" ADD COLUMN     "static_map_key" TEXT;
