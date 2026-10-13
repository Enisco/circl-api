import { Weekday } from '@prisma/client';
import { minutesOfDayIn } from '@/common';

/**
 * One clock for everything that keeps weekly hours.
 *
 * The shop's "Open now" and the professional's "Contactable now" are the same question about the
 * same shape, and v2 §4.2 is explicit that they must be the same code: *"the same function must
 * back any `contactableNow` filter"*. Two implementations would drift, and the way they drift is
 * that a badge and the filter beside it disagree — which reads as the list being wrong rather than
 * as two functions being different.
 *
 * Timezone-aware rather than offset arithmetic, because the owner's clock is the one that matters.
 * A member in Lagos reading a Manchester professional's page must see whether *Manchester* is
 * within hours, and the UK moves its clocks twice a year.
 */

/** Monday first, which is how both features store and render their week. */
export const WEEK: Weekday[] = [
  Weekday.MONDAY,
  Weekday.TUESDAY,
  Weekday.WEDNESDAY,
  Weekday.THURSDAY,
  Weekday.FRIDAY,
  Weekday.SATURDAY,
  Weekday.SUNDAY,
];

export interface WeeklyHours {
  day: Weekday;
  openMinutes: number | null;
  closeMinutes: number | null;
}

/**
 * Whether `at` falls inside the week's hours, in the owner's timezone.
 *
 * **No hours at all is inside them.** Somebody who never filled the form in has not said they are
 * never available, and reading an empty week as "closed every day" prints a claim they never made
 * — which is what used to happen to every shop that skipped the step.
 *
 * Yesterday is checked too, because a window that closes after midnight is still open at one in
 * the morning.
 */
export const isWithinWeeklyHours = (
  timezone: string,
  hours: WeeklyHours[] | null | undefined,
  at: Date = new Date(),
): boolean => {
  if (!hours?.length) return true;

  const { weekday, minutes } = minutesOfDayIn(timezone, at);
  const todayIndex = WEEK.findIndex(day => day === weekday);

  if (todayIndex === -1) return false;

  const byDay = new Map(hours.map(row => [row.day, row] as const));
  const today = byDay.get(WEEK[todayIndex]);
  const yesterday = byDay.get(WEEK[(todayIndex + 6) % 7]);

  const withinToday =
    !!today &&
    today.openMinutes !== null &&
    today.closeMinutes !== null &&
    (today.closeMinutes > today.openMinutes
      ? minutes >= today.openMinutes && minutes < today.closeMinutes
      : minutes >= today.openMinutes);

  const spilledFromYesterday =
    !!yesterday &&
    yesterday.openMinutes !== null &&
    yesterday.closeMinutes !== null &&
    yesterday.closeMinutes <= yesterday.openMinutes &&
    minutes < yesterday.closeMinutes;

  return withinToday || spilledFromYesterday;
};

/**
 * Seven entries Monday first, or null where none are kept.
 *
 * Three states, and the middle one is the one that gets lost: no rows means "by appointment" and
 * comes back as null, **not** as seven closed days — which would be a claim that the owner never
 * opens.
 */
export const toWeeklyHours = (rows: WeeklyHours[]): WeeklyHours[] | null => {
  if (!rows.length) return null;

  const byDay = new Map(rows.map(row => [row.day, row] as const));

  return WEEK.map(day => ({
    day,
    openMinutes: byDay.get(day)?.openMinutes ?? null,
    closeMinutes: byDay.get(day)?.closeMinutes ?? null,
  }));
};
