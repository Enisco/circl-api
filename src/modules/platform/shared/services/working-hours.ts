import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import { WorkingHours } from '@/common';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * A clock that only runs during working hours (§7.4, §13.5).
 *
 * An anonymous post is due four **working** hours after it is written, not four wall-clock hours.
 * The distinction is the whole point: a wall clock makes everything posted on Friday evening
 * overdue by Saturday lunchtime, so Monday morning opens on a queue that is entirely red and the
 * colour stops meaning anything. Urgent work keeps a wall clock — `queue-priority.ts` decides
 * which — because an hour is an hour at three in the morning.
 *
 * `moderation.workingHours` has been a configured default since §5 and nothing has ever read it.
 * This is its reader.
 *
 * Timezone-aware rather than offset arithmetic, and that is not pedantry: the UK changes clocks
 * twice a year, and "09:00 Europe/London" is a different instant in January and July. Adding
 * minutes to a UTC timestamp and formatting it later gets the last Sunday in March wrong in a way
 * nobody notices until an SLA report is read.
 */

/** `"09:00"` → minutes after midnight. Returns null for anything that is not a time. */
const minutesOfDay = (value: string): number | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);

  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (hours > 24 || minutes > 59) return null;

  return hours * 60 + minutes;
};

/**
 * ISO weekday, Monday = 1, in the configured zone.
 *
 * `dayjs().day()` is 0 for Sunday, and `WorkingHours.days` is documented as ISO — so Sunday is 7
 * here. Getting this wrong makes Sunday a working day and Monday a weekend, which is the kind of
 * off-by-one that looks like a timezone bug for a week.
 */
const isoWeekday = (moment: dayjs.Dayjs): number => moment.day() || 7;

/**
 * Adds `minutes` of working time to `from`.
 *
 * Walks forward a day at a time rather than minute by minute: a deadline is at most a few days out
 * and the loop has to terminate even if somebody configures a week with no working days in it,
 * which is what `MAX_DAYS` is for. Without that bound a misconfiguration is an infinite loop in a
 * write path, which is a worse failure than a wrong date.
 */
export const addWorkingMinutes = (from: Date, minutes: number, hours: WorkingHours): Date => {
  const start = minutesOfDay(hours.start);
  const end = minutesOfDay(hours.end);
  const days = hours.days?.filter(day => day >= 1 && day <= 7) ?? [];

  // A window that is not a window. Falling back to the wall clock is the honest answer: the
  // deadline is still a deadline, and silently returning `from` would mark everything overdue the
  // moment it was created.
  if (start === null || end === null || end <= start || !days.length) {
    return new Date(from.getTime() + minutes * 60_000);
  }

  let remaining = Math.max(0, minutes);
  let cursor = dayjs(from).tz(hours.tz);

  const MAX_DAYS = 400;

  for (let guard = 0; guard < MAX_DAYS; guard += 1) {
    if (!days.includes(isoWeekday(cursor))) {
      cursor = cursor.add(1, 'day').startOf('day');
      continue;
    }

    const minuteOfDay = cursor.hour() * 60 + cursor.minute();

    if (minuteOfDay < start) {
      // Before opening: the clock has not started today.
      cursor = cursor.startOf('day').add(start, 'minute');
      continue;
    }

    if (minuteOfDay >= end) {
      // After closing: nothing more happens today.
      cursor = cursor.add(1, 'day').startOf('day');
      continue;
    }

    const leftToday = end - minuteOfDay;

    if (remaining <= leftToday) {
      return cursor.add(remaining, 'minute').toDate();
    }

    remaining -= leftToday;
    cursor = cursor.add(1, 'day').startOf('day');
  }

  // Unreachable with a sane configuration, and the fallback is deliberately a real date rather
  // than a throw: a deadline this service cannot compute must not stop a post being written.
  return new Date(from.getTime() + Math.max(0, minutes) * 60_000);
};

/** Whether `at` falls inside the window. Used by nothing yet; the SLA reports in §5.21 will want it. */
export const isWorkingTime = (at: Date, hours: WorkingHours): boolean => {
  const start = minutesOfDay(hours.start);
  const end = minutesOfDay(hours.end);

  if (start === null || end === null) return true;

  const moment = dayjs(at).tz(hours.tz);
  const minuteOfDay = moment.hour() * 60 + moment.minute();

  return (
    (hours.days ?? []).includes(isoWeekday(moment)) && minuteOfDay >= start && minuteOfDay < end
  );
};

/** Exported for the spec, which is the only place that should know how a time string is parsed. */
export const __minutesOfDay = minutesOfDay;
