/**
 * Age derived from a date of birth (3.1.2).
 *
 * Connect derives this and never stores a number: a number cannot be
 * re-validated later, and someone who typed 18 last year is still 18 forever.
 */
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
