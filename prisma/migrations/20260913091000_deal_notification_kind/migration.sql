-- A deal step is worth a notification of its own: the seller who does not know the buyer has
-- paid will not dispatch.

ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'DEAL';
