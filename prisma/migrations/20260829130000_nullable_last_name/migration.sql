-- The app has one name input and splits it on the first space, so a member with
-- a single-word name sends no last name at all (spec 0.16.2). Existing rows are
-- unaffected: this only stops the column rejecting the absence.
--
-- Prisma's generated DROP INDEX statements were removed by hand: the trigram and
-- partial indexes are created in raw SQL and are invisible to the schema.

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "last_name" DROP NOT NULL;
