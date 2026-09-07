-- A booking or an order moving is the one thing in the `BOOKINGS` preference row, and until now
-- nothing raised it: a state change wrote a system line into the conversation, which is not unread
-- and does not push, so a professional learned about a new booking only by opening the app.
--
-- ANNOUNCEMENT would have rendered it as a grey row with no icon. A new kind renders that way too
-- on an older build (6.1.1) and correctly on a new one, so it costs nothing to be honest.
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'BOOKING';
