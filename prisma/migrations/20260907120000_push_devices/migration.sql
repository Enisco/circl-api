-- Push was one token per member, held in a column. Signing in on a second device overwrote the
-- first, so the phone silently stopped receiving anything and nothing in the data said why.
--
-- The token stays globally unique. A handset holds one token, so when it changes hands the row
-- MOVES to whoever signed in, rather than existing twice and delivering the previous member's
-- notifications to the person holding it now.
CREATE TYPE "DevicePlatform" AS ENUM ('IOS', 'ANDROID', 'WEB');

CREATE TABLE "push_devices" (
  "id"           TEXT NOT NULL,
  "user_id"      TEXT NOT NULL,
  "token"        TEXT NOT NULL,
  "platform"     "DevicePlatform",
  "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "push_devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "push_devices_token_key" ON "push_devices"("token");
CREATE INDEX "push_devices_user_id_idx" ON "push_devices"("user_id");

ALTER TABLE "push_devices"
  ADD CONSTRAINT "push_devices_user_id_fkey" FOREIGN KEY ("user_id")
  REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Everyone already registered keeps their push working across the deploy. `DISTINCT ON` because
-- the old column had no uniqueness of its own, so the same token could in principle sit on two
-- rows; the newest wins, which is the same rule the new table enforces.
INSERT INTO "push_devices" ("id", "user_id", "token", "last_seen_at", "created_at")
SELECT DISTINCT ON ("device_push_token")
  gen_random_uuid()::text, "user_id", "device_push_token", "updated_at", "updated_at"
FROM "user_notification_prefs"
WHERE "device_push_token" IS NOT NULL AND "device_push_token" <> ''
ORDER BY "device_push_token", "updated_at" DESC;

-- Dropped rather than kept in sync: two places holding the same fact is how they come to disagree.
ALTER TABLE "user_notification_prefs" DROP COLUMN "device_push_token";
