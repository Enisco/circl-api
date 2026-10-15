/**
 * How long a one-time code is, and the fixed one used outside production.
 *
 * Every OTP in this API is emailed — sign-in verification, the email-change confirmation, the
 * account-deletion confirmation, staff sign-in — and there is no mail provider yet, so a random
 * code is a code nobody can read. Until Resend is in place, non-production environments generate a
 * known one.
 *
 * ## Why this is a generator and not a bypass
 *
 * There was already a bypass: `validateOtp` accepted one hard-coded four-digit literal whenever
 * `APP_ENV !== 'production'`, short-circuiting the comparison entirely. Two things were wrong with
 * it, and the second is the serious one:
 *
 * 1. It checked **one** signal. `??`-style single-signal guards fall through on *unset*, not on
 *    *different*, so a deployment running `NODE_ENV=production` with `APP_ENV` unset — or set to
 *    anything else — read as non-production, and the bypass was live. The demo seeder already
 *    carries a comment about exactly this mistake; the auth path had it anyway.
 * 2. A bypass is a second code path through an authentication check. The branch that returns
 *    `true` before looking at the stored hash is the branch that must never be reachable in
 *    production, and whether it is reachable depends on configuration being right.
 *
 * Making the *generated* code deterministic instead means the ordinary path runs: the code is
 * hashed, stored, and compared like any other. There is no branch to reach, so a misconfigured
 * environment cannot skip the comparison — the worst it can do is make the code guessable, which
 * is the thing we are choosing on purpose and only off production.
 *
 * Replace this by deleting `fixedOtp` and its one call in `Util.generateOtp`. Nothing else
 * references it, and no verification logic changes when it goes. `OTP_LENGTH` stays: it is a
 * product decision, not a development aid.
 */

/**
 * Whether this process is production, by **either** signal.
 *
 * Both are checked because they disagree in the one configuration that matters. A guard that reads
 * only one of them is a guard that is off exactly where it is needed.
 */
export const isProductionEnv = (): boolean =>
  [process.env.NODE_ENV, process.env.APP_ENV].includes('production');

/**
 * Set `DEV_FIXED_OTP=false` to get random codes in development too — useful for testing the real
 * mail path once there is one. It cannot turn the fixed code *on* in production: that is decided
 * by the environment, not by a flag.
 */
const optedOut = (): boolean => process.env.DEV_FIXED_OTP === 'false';

/**
 * Six digits, everywhere.
 *
 * One number for the whole API rather than a length per flow. Member sign-in used to be four while
 * every other code was six, which meant two fixed development codes to remember and a mobile app
 * carrying a different validation rule from the rest of the surface. It is here, next to
 * `FIXED_OTP`, because the two have to agree — see `fixedOtp`.
 */
export const OTP_LENGTH = 6;

export const FIXED_OTP = '111222';

/**
 * The fixed code, or null when a real random one must be used.
 *
 * Refuses when the caller wants a length the fixed code cannot supply, rather than returning a
 * truncated or short one: a wrong-length development code fails the DTO that validates it, which
 * looks like a broken endpoint rather than a mismatched constant. Falling through to a random code
 * leaves the flow working and the cause findable.
 */
export const fixedOtp = (length: number): string | null =>
  isProductionEnv() || optedOut() || length !== FIXED_OTP.length ? null : FIXED_OTP;
