-- A row with no status_code is a reservation: the key is taken and the call is still running.
-- That is how a duplicate arriving mid-flight is told apart from a retry of something answered.
ALTER TABLE "idempotency_records" ALTER COLUMN "status_code" DROP NOT NULL;
ALTER TABLE "idempotency_records" ALTER COLUMN "response_body" DROP NOT NULL;

-- When the attempt now holding this key began, so a process that dies mid-request does not hold
-- the key for the whole window. Existing rows are all finished, so the backfill value is unused.
ALTER TABLE "idempotency_records" ADD COLUMN "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
