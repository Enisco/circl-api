-- Deals: a shared record of a transaction between two people in one conversation.

CREATE TYPE "DealTrack" AS ENUM ('COMMERCE', 'PROFESSIONAL');
CREATE TYPE "DealRole" AS ENUM ('PAYER', 'PROVIDER');
CREATE TYPE "DealTiming" AS ENUM ('UPFRONT', 'ON_COMPLETION');
CREATE TYPE "DealStage" AS ENUM (
  'AGREED', 'DEPOSIT_PAID', 'DEPOSIT_CONFIRMED', 'PAID', 'PAYMENT_CONFIRMED',
  'STARTED', 'WORK_DELIVERED', 'DISPATCHED', 'GOODS_RECEIVED', 'ACCEPTED', 'DONE'
);

ALTER TYPE "SystemMessageType" ADD VALUE IF NOT EXISTS 'DEAL_PROPOSED';
ALTER TYPE "SystemMessageType" ADD VALUE IF NOT EXISTS 'DEAL_STEP_MARKED';
ALTER TYPE "SystemMessageType" ADD VALUE IF NOT EXISTS 'DEAL_PROBLEM_FLAGGED';

CREATE TABLE "deals" (
  "id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "track" "DealTrack" NOT NULL,
  "payer_id" TEXT NOT NULL,
  "provider_id" TEXT NOT NULL,
  "proposed_by_role" "DealRole" NOT NULL,
  "amount" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'GBP',
  "timing" "DealTiming" NOT NULL,
  "deposit_amount" INTEGER,
  "collects" BOOLEAN NOT NULL DEFAULT false,
  "summary" TEXT,
  "is_agreed_by_both" BOOLEAN NOT NULL DEFAULT false,
  "has_problem" BOOLEAN NOT NULL DEFAULT false,
  "problem_note" TEXT,
  "problem_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "deals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "deal_steps" (
  "id" TEXT NOT NULL,
  "deal_id" TEXT NOT NULL,
  "stage" "DealStage" NOT NULL,
  "by_role" "DealRole" NOT NULL,
  "amount" INTEGER,
  "currency" TEXT,
  "reached_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "deal_steps_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "deals_conversation_id_key" ON "deals"("conversation_id");
CREATE INDEX "deals_payer_id_idx" ON "deals"("payer_id");
CREATE INDEX "deals_provider_id_idx" ON "deals"("provider_id");

-- A stage happens once: this is what makes "nothing twice" a database rule rather than a hope.
CREATE UNIQUE INDEX "deal_steps_deal_id_stage_key" ON "deal_steps"("deal_id", "stage");
CREATE INDEX "deal_steps_deal_id_reached_at_idx" ON "deal_steps"("deal_id", "reached_at");

ALTER TABLE "deals" ADD CONSTRAINT "deals_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deals" ADD CONSTRAINT "deals_payer_id_fkey"
  FOREIGN KEY ("payer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deals" ADD CONSTRAINT "deals_provider_id_fkey"
  FOREIGN KEY ("provider_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deal_steps" ADD CONSTRAINT "deal_steps_deal_id_fkey"
  FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
