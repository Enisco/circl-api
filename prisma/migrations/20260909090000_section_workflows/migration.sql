-- Sections, chats and reputation, now that booking is gone.
--
-- Three things: a STORE thread context so a shop profile files under Commerce, a PROFESSIONAL
-- review context so a professional can be rated for work that never became a booking, and the
-- backfill that gives every existing thread the kind its context always implied.

ALTER TYPE "ThreadContextType" ADD VALUE IF NOT EXISTS 'STORE';
ALTER TYPE "ReviewContext" ADD VALUE IF NOT EXISTS 'PROFESSIONAL';

ALTER TABLE "reputation_summaries"
  ADD COLUMN IF NOT EXISTS "professional_count" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "conversation_id" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reviews_conversation_id_fkey'
  ) THEN
    ALTER TABLE "reviews"
      ADD CONSTRAINT "reviews_conversation_id_fkey"
      FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Every thread came back as DIRECT whatever it was about, so a section filter that pages
-- server-side had nothing to filter on. The kind was always derivable from the context.
UPDATE "conversations"
SET "kind" = CASE "context_type"
  WHEN 'REQUEST' THEN 'COMMUNITY'::"ThreadKind"
  WHEN 'OFFER' THEN 'COMMUNITY'::"ThreadKind"
  WHEN 'PROFESSIONAL' THEN 'PROFESSIONAL'::"ThreadKind"
  WHEN 'BOOKING' THEN 'PROFESSIONAL'::"ThreadKind"
  WHEN 'CONNECT_PROFILE' THEN 'CONNECT'::"ThreadKind"
  WHEN 'ITEM' THEN 'COMMERCE'::"ThreadKind"
  WHEN 'ORDER' THEN 'COMMERCE'::"ThreadKind"
  ELSE "kind"
END
WHERE "context_type" IS NOT NULL AND "kind" = 'DIRECT';
