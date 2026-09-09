-- A thread is about one service, not a whole listing.
--
-- Existing PROFESSIONAL threads are deliberately left alone: which of a listing's services they
-- were about is not recorded anywhere, and a guess written into the record is worse than a record
-- that is honestly vague.

ALTER TYPE "ThreadContextType" ADD VALUE IF NOT EXISTS 'SERVICE';
