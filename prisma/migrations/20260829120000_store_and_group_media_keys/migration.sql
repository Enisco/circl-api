-- Store logo/cover and group avatar become object keys rather than URLs, so they
-- are signed on read like every other piece of Circl media (spec 0.11.3). The old
-- columns held public URLs that no longer exist under a private bucket, so there
-- is nothing worth migrating across.
--
-- The trigram and partial indexes are created in raw SQL and are invisible to the
-- Prisma schema, so its generated DROP INDEX statements were removed by hand.

-- AlterTable
ALTER TABLE "groups" DROP COLUMN "avatar_url",
ADD COLUMN     "avatar_key" TEXT;

-- AlterTable
ALTER TABLE "stores" DROP COLUMN "cover_url",
DROP COLUMN "logo_url",
ADD COLUMN     "cover_key" TEXT,
ADD COLUMN     "logo_key" TEXT;
