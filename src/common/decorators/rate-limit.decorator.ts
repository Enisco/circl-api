import { applyDecorators } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

/** The limits from spec 0.14, plus messaging's own pair from 5.7. */
export const RATE_LIMITS = {
  /** Content creation: post, reply, response, guide, group. 20 per hour. */
  CREATE: { limit: 20, ttl: 3_600_000 },
  /** Reactions and joins. 120 per hour. */
  REACT: { limit: 120, ttl: 3_600_000 },
  /** Reads. 600 per minute. Also the default for anything unclassified. */
  READ: { limit: 600, ttl: 60_000 },
  /** Reports. 10 per hour. */
  REPORT: { limit: 10, ttl: 3_600_000 },
  /** Messaging (5.7): 60 a minute AND 300 an hour. */
  MESSAGE_MINUTE: { limit: 60, ttl: 60_000 },
  MESSAGE_HOUR: { limit: 300, ttl: 3_600_000 },
  /** Anything that sends a six-digit code to an inbox. 5 an hour. */
  OTP: { limit: 5, ttl: 3_600_000 },

  // ─── Admin portal (§3.3) ───────────────────────────────────────────────────
  // Tighter than anything a member meets, because what is behind these is every member's data.
  /** Staff sign-in. 5 in 15 minutes; the account lock behind it does the rest. */
  ADMIN_LOGIN: { limit: 5, ttl: 900_000 },
  /** The second factor. Looser than the password step, which has already been passed. */
  ADMIN_MFA: { limit: 10, ttl: 900_000 },
  /** Refresh. One session should need four an hour; sixty leaves room for a retry storm. */
  ADMIN_REFRESH: { limit: 60, ttl: 60_000 },
  /** Invite inspection: an unauthenticated endpoint that takes a token. */
  ADMIN_INVITE_INSPECT: { limit: 20, ttl: 3_600_000 },
  /** Invite acceptance and enrolment. */
  ADMIN_SETUP: { limit: 10, ttl: 3_600_000 },
  /** Re-authentication on own-account changes. */
  ADMIN_REAUTH: { limit: 5, ttl: 900_000 },
  /** Admin writes. */
  ADMIN_WRITE: { limit: 120, ttl: 60_000 },
  /**
   * The command palette and the member search (§3.3): sixty a minute per staff member.
   *
   * Looser than it sounds — somebody typing into a palette with a debounce makes a handful a
   * second in bursts — and tighter than `ADMIN_WRITE` is in the way that matters: these are the
   * two endpoints that take a name or an email address and say whether it is on the platform, so
   * the limit is what stops the palette being used to enumerate members one guess at a time.
   */
  ADMIN_SEARCH: { limit: 60, ttl: 60_000 },
  /**
   * The lexicon phrase tester (§5.13): sixty a minute.
   *
   * Its own bucket rather than `ADMIN_WRITE` because it writes nothing and because, with
   * `includeClassifier`, each call is a paid request to a third party — so the limit is a cost
   * ceiling as much as an abuse one. Tuning a term is an iterative job, so sixty leaves room to
   * work without leaving a text box that bills per keystroke.
   */
  PHRASE_TEST: { limit: 60, ttl: 60_000 },
  /**
   * The portal recording its own CSV downloads (§5.23): 120 an hour per staff member.
   *
   * An hour rather than a minute, because the thing being limited is not abuse of an expensive
   * endpoint — the write is one row — but a client bug turning the audit trail into a log of
   * itself. A hundred and twenty exports an hour is more than anybody does and far less than a
   * loop would.
   */
  ADMIN_CLIENT_EVENT: { limit: 120, ttl: 3_600_000 },

  // ─── The public website ────────────────────────────────────────────────────
  /**
   * The website's three forms — contact, suggestion, deletion request. Five an hour per IP.
   *
   * These are the only unauthenticated writes on the platform that anybody can reach without an
   * account, so the limit is the whole defence on this side: the website drops the obvious bots
   * before calling (a honeypot field, and a form sent inside 2.5 seconds), and nothing smarter is
   * stopped by either. Five is generous for a person and useless for a script.
   *
   * Deletion requests carry a second, per-email limit as well, which this cannot express: it
   * protects a *person's inbox* from somebody moving between networks, not the API from a flood.
   * See `WebsiteSubmissionService`.
   */
  WEBSITE_FORM: { limit: 5, ttl: 3_600_000 },
} as const;

type LimitName = keyof typeof RATE_LIMITS;

/** Applies a limit to one route. */
export const RateLimit = (primary: LimitName, secondary?: LimitName) =>
  applyDecorators(
    Throttle({
      default: RATE_LIMITS[primary],
      ...(secondary ? { secondary: RATE_LIMITS[secondary] } : {}),
    }),
  );
