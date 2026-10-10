/** Age derived from a date of birth (3.1.2). */
export const ageFromDateOfBirth = (dateOfBirth: Date | null | undefined): number | null => {
  if (!dateOfBirth) return null;

  const now = new Date();
  let age = now.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - dateOfBirth.getUTCMonth();

  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dateOfBirth.getUTCDate())) {
    age -= 1;
  }

  return age;
};

/** A `YYYY-MM-DD` string, for the date-only fields the client sends and reads. */
export const toDateOnly = (date: Date | null | undefined): string | null =>
  date ? date.toISOString().slice(0, 10) : null;

export const addDays = (date: Date, days: number): Date =>
  new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

export const daysAgo = (days: number): Date => addDays(new Date(), -days);

/** Minutes from midnight in a given IANA timezone, for the opening-hours check. */
export const minutesOfDayIn = (timezone: string, at: Date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'long',
    hour12: false,
  }).formatToParts(at);

  const lookup = (type: string) => parts.find(part => part.type === type)?.value ?? '0';

  return {
    weekday: lookup('weekday').toUpperCase(),
    minutes: Number(lookup('hour')) * 60 + Number(lookup('minute')),
  };
};

/**
 * The window of birth dates that produces an age between these bounds, both inclusive.
 *
 * Age is derived rather than stored, which is deliberate — a stored age is wrong within a year and
 * nobody notices. But deriving it does not mean filtering in memory: turning the bounds into a date
 * range filters on the column itself, so a count, a page and a facet all see the same rows. Filtering
 * afterwards made the count describe a different set from the grid.
 *
 * `latest` is the newest birth date still old enough; `earliest` the oldest one still young enough.
 */
export const birthDateRangeForAges = (
  minAge: number | undefined,
  maxAge: number | undefined,
  now: Date = new Date(),
): { earliest?: Date; latest?: Date } => {
  const shiftYears = (years: number): Date => {
    const shifted = new Date(now);

    shifted.setUTCFullYear(shifted.getUTCFullYear() - years);

    return shifted;
  };

  return {
    // Turning maxAge today is still within maxAge, so the day itself is included: anyone born after
    // this instant is younger than the bound allows.
    ...(maxAge === undefined ? {} : { earliest: shiftYears(maxAge + 1) }),
    ...(minAge === undefined ? {} : { latest: shiftYears(minAge) }),
  };
};

/**
 * Every bucket, boundary, "today" and SLA clock in the admin portal (§2.6).
 *
 * Named rather than written out at each call site because the whole point is that there is one
 * answer to "which day is it": a member active at 23:30 on the 5th in British Summer Time belongs
 * to the 5th, and `toISOString().slice(0, 10)` files them on the 6th for half the year.
 */
export const LONDON_TIMEZONE = 'Europe/London';

/**
 * How far London is from UTC at a given instant, in milliseconds.
 *
 * Measured rather than assumed. The offset is the thing that changes — twice a year, and not on
 * the same dates as anywhere else — so the only reliable way to get it is to ask the timezone
 * database what the wall clock said at that instant and subtract.
 */
const londonOffsetMs = (at: Date): number => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: LONDON_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);

  const part = (type: string): number =>
    Number(parts.find(entry => entry.type === type)?.value ?? 0);

  const wallClockAsUtc = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );

  return wallClockAsUtc - at.getTime();
};

/** The London calendar date of an instant, as `YYYY-MM-DD`. */
export const londonDateString = (at: Date = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: LONDON_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);

/**
 * The instant midnight London began on a given calendar date.
 *
 * Two passes. The offset is read at the UTC reading of the date, which is within an hour of the
 * answer, and then again at the answer — because on the two days a year the clocks change those
 * two instants can sit either side of the change, and a one-hour error on a range boundary moves
 * rows between buckets.
 */
export const londonMidnight = (dateOnly: string): Date => {
  const naive = Date.parse(`${dateOnly}T00:00:00Z`);

  if (Number.isNaN(naive)) throw new TypeError(`Not a calendar date: ${dateOnly}`);

  const firstGuess = naive - londonOffsetMs(new Date(naive));

  return new Date(naive - londonOffsetMs(new Date(firstGuess)));
};

/** `YYYY-MM-DD` shifted by whole calendar days, which is not the same as adding 24 hours. */
export const shiftDateOnly = (dateOnly: string, days: number): string => {
  const shifted = new Date(Date.parse(`${dateOnly}T00:00:00Z`) + days * 86_400_000);

  return shifted.toISOString().slice(0, 10);
};

/** Whole days from one calendar date to another, inclusive of both ends. */
export const dateOnlySpan = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/**
 * A London calendar day as the value a `@db.Date` column holds.
 *
 * Postgres `date` has no timezone, and Prisma reads and writes it at UTC midnight, so the day must
 * be built that way even though the day itself was decided in London.
 */
export const londonCalendarDay = (at: Date = new Date()): Date =>
  new Date(`${londonDateString(at)}T00:00:00.000Z`);
