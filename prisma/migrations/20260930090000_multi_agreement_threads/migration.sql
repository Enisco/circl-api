-- A thread runs as many agreements as the two people in it need.
--
-- One deal per conversation meant a second quote either overwrote the first or forced a new thread
-- that lost the conversation the first was settled in. Dropping the unique index is the whole of
-- the model change; everything else is the rules around it.
DROP INDEX IF EXISTS "deals_conversation_id_key";

CREATE INDEX IF NOT EXISTS "deals_conversation_id_created_at_idx"
  ON "deals" ("conversation_id", "created_at");

-- Withdrawn before anybody agreed. The row stays, because what the two of them discussed is part of
-- the record; the app shows it greyed and read-only.
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "is_cancelled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "cancelled_at" TIMESTAMPTZ;
