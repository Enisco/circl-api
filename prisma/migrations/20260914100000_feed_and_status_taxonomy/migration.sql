-- The community feed's filter row and the request list's status chips were chosen by array index
-- in the client. Giving them codes is what stops a reorder from silently filtering for the wrong
-- thing.
ALTER TYPE "TaxonomyKind" ADD VALUE IF NOT EXISTS 'FEED_TYPE';
ALTER TYPE "TaxonomyKind" ADD VALUE IF NOT EXISTS 'REQUEST_STATUS';
