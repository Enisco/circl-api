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
