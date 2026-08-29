-- The five PRF-03 booleans become the eight-row preference matrix (spec 6.1.3).
--
-- The choices are carried across BEFORE the columns are dropped. A member who
-- turned group activity off did so deliberately, and a migration that silently
-- switched it back on would be the worst kind of regression: invisible until they
-- notice the notifications they thought they had stopped.
--
-- Only a choice that differs from the new default is written. Absence of a row
-- already means "the default", so inserting one for every member would fill the
-- table with rows that say nothing and would freeze those members on today's
-- defaults if a default is ever changed.
--
-- Email is not carried: the old shape had no email channel, so every migrated row
-- takes the category's email default.

INSERT INTO "notification_preferences" ("user_id", "category_code", "push", "email", "updated_at")
SELECT "user_id", mapping.code, false, mapping.default_email, NOW()
FROM "user_notification_prefs"
CROSS JOIN LATERAL (
  VALUES
    ('OFFERS',        "new_offers_on_my_requests", true),
    ('MESSAGES',      "new_messages",              false),
    ('GROUPS',        "group_activity",            false),
    ('CONNECTIONS',   "connection_requests",       false),
    ('ANNOUNCEMENTS', "platform_updates",          false)
) AS mapping(code, was_on, default_email)
-- GROUPS already defaults to push off, so a member who had it off is at the
-- default and needs no row. Everything else defaulted to on.
WHERE mapping.was_on = false AND mapping.code <> 'GROUPS'
ON CONFLICT ("user_id", "category_code") DO NOTHING;

-- Prisma's generated DROP INDEX statements were removed by hand: the trigram and
-- partial indexes are created in raw SQL and are invisible to the schema.

-- AlterTable
ALTER TABLE "user_notification_prefs" DROP COLUMN "connection_requests",
DROP COLUMN "group_activity",
DROP COLUMN "new_messages",
DROP COLUMN "new_offers_on_my_requests",
DROP COLUMN "platform_updates";
