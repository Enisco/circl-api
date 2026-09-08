-- Derived media fields (width, height, duration) are read from the object's own header after the
-- bytes land. This records that the read happened, so the sweeper can tell "not tried yet" from
-- "tried, and there was nothing to read": without it, every unreadable object is re-fetched from
-- S3 every hour, forever.
ALTER TABLE "media" ADD COLUMN "derived_at" TIMESTAMPTZ;

-- Anything that already has dimensions was seeded with them and needs no visit.
UPDATE "media" SET "derived_at" = "created_at" WHERE "width" IS NOT NULL;

-- The sweeper reads exactly this: never derived, ordered by age.
CREATE INDEX "media_derived_at_idx" ON "media" ("derived_at") WHERE "derived_at" IS NULL;
