import { SYSTEM_CONFIG_DEFAULTS, WorkingHours } from '@/common';
import { addWorkingMinutes, isWorkingTime } from '../working-hours';

/**
 * The clock that only runs Monday to Friday, 09:00–18:00 Europe/London.
 *
 * Asserted against instants rather than against formatted strings, because the thing most likely
 * to be wrong is the timezone and a formatted string hides it. Every expectation below is a UTC
 * instant with the London wall time written beside it.
 */
const HOURS = SYSTEM_CONFIG_DEFAULTS['moderation.workingHours'] as WorkingHours;
const FOUR_HOURS = 240;

const at = (iso: string) => new Date(iso);

describe('addWorkingMinutes', () => {
  it('stays inside the same day when there is room', () => {
    // Tuesday 10:00 London (BST, so 09:00Z) + 4h = 14:00 London.
    expect(addWorkingMinutes(at('2026-06-09T09:00:00Z'), FOUR_HOURS, HOURS).toISOString()).toBe(
      '2026-06-09T13:00:00.000Z',
    );
  });

  it('carries the remainder into the next morning', () => {
    // Tuesday 16:00 London. Two hours left today, so two more from Wednesday 09:00 → 11:00.
    expect(addWorkingMinutes(at('2026-06-09T15:00:00Z'), FOUR_HOURS, HOURS).toISOString()).toBe(
      '2026-06-10T10:00:00.000Z',
    );
  });

  it('does not start the clock before opening time', () => {
    // Tuesday 06:00 London: the four hours begin at 09:00, not at 06:00.
    expect(addWorkingMinutes(at('2026-06-09T05:00:00Z'), FOUR_HOURS, HOURS).toISOString()).toBe(
      '2026-06-09T12:00:00.000Z',
    );
  });

  it('skips the weekend', () => {
    // Friday 17:00 London: one hour today, three from Monday 09:00 → Monday 12:00.
    expect(addWorkingMinutes(at('2026-06-12T16:00:00Z'), FOUR_HOURS, HOURS).toISOString()).toBe(
      '2026-06-15T11:00:00.000Z',
    );
  });

  it('is the whole reason this is not a wall clock: Friday evening is not overdue by Saturday', () => {
    const friday = at('2026-06-12T20:00:00Z'); // Friday 21:00 London, after closing
    const due = addWorkingMinutes(friday, FOUR_HOURS, HOURS);

    // Monday 13:00 London, not Saturday lunchtime.
    expect(due.toISOString()).toBe('2026-06-15T12:00:00.000Z');
    expect(due.getTime() - friday.getTime()).toBeGreaterThan(48 * 3_600_000);
  });

  it('handles the spring clock change, which offset arithmetic gets wrong', () => {
    // Friday 27 March 2026 16:00 London — GMT, so 16:00Z. Two hours left before 18:00, then two
    // more from Monday 09:00, by which time the clocks have gone forward: Monday 09:00 BST is
    // 08:00Z, so the answer is 10:00Z. Adding 4h × 60 × 1000 to a UTC timestamp and formatting it
    // in London would land an hour out.
    expect(addWorkingMinutes(at('2026-03-27T16:00:00Z'), FOUR_HOURS, HOURS).toISOString()).toBe(
      '2026-03-30T10:00:00.000Z',
    );
  });

  it('handles the autumn clock change in the other direction', () => {
    // Friday 23 October 2026 16:00 London — BST, so 15:00Z. Two hours left, then two from Monday
    // 09:00 GMT, which is 09:00Z: 11:00Z.
    expect(addWorkingMinutes(at('2026-10-23T15:00:00Z'), FOUR_HOURS, HOURS).toISOString()).toBe(
      '2026-10-26T11:00:00.000Z',
    );
  });

  it('spans several days when the window is shorter than the budget', () => {
    // Monday 09:00 London + 20 working hours: nine on Monday, nine on Tuesday, two on Wednesday,
    // landing at 11:00 London — 10:00Z in June.
    expect(addWorkingMinutes(at('2026-06-08T08:00:00Z'), 20 * 60, HOURS).toISOString()).toBe(
      '2026-06-10T10:00:00.000Z',
    );
  });

  it('treats zero as now', () => {
    expect(addWorkingMinutes(at('2026-06-09T09:00:00Z'), 0, HOURS).toISOString()).toBe(
      '2026-06-09T09:00:00.000Z',
    );
  });

  describe('a window that is not a window', () => {
    // Falling back to a wall clock, not to `from`: a deadline this cannot compute is still a
    // deadline, and returning `from` would mark everything overdue the moment it was created.
    const wallClock = (hours: Partial<WorkingHours>) =>
      addWorkingMinutes(at('2026-06-09T09:00:00Z'), FOUR_HOURS, {
        ...HOURS,
        ...hours,
      }).toISOString();

    it('falls back to the wall clock with no working days', () => {
      expect(wallClock({ days: [] })).toBe('2026-06-09T13:00:00.000Z');
    });

    it('falls back when the window closes before it opens', () => {
      expect(wallClock({ start: '18:00', end: '09:00' })).toBe('2026-06-09T13:00:00.000Z');
    });

    it('falls back on an unparseable time', () => {
      expect(wallClock({ start: 'nine o clock' })).toBe('2026-06-09T13:00:00.000Z');
    });

    it('ignores weekday numbers that are not weekdays', () => {
      // `0` and `9` are not ISO weekdays and are dropped, leaving Wednesday. From Tuesday 10:00
      // London that means waiting for Wednesday 09:00 and finishing at 13:00 — 12:00Z. A `0` read
      // as Sunday, or a `9` kept, would answer something else.
      expect(wallClock({ days: [0, 9, 3] })).toBe('2026-06-10T12:00:00.000Z');
    });
  });
});

describe('isWorkingTime', () => {
  it('is true inside the window', () => {
    expect(isWorkingTime(at('2026-06-09T09:00:00Z'), HOURS)).toBe(true);
  });

  it('is false at the weekend', () => {
    expect(isWorkingTime(at('2026-06-13T11:00:00Z'), HOURS)).toBe(false);
  });

  it('is false before opening and at closing', () => {
    expect(isWorkingTime(at('2026-06-09T05:00:00Z'), HOURS)).toBe(false);
    // 18:00 London exactly: the window is half-open, so closing time is outside it.
    expect(isWorkingTime(at('2026-06-09T17:00:00Z'), HOURS)).toBe(false);
  });

  it('reads Sunday as ISO 7, not as 0', () => {
    // Sunday 14 June 2026, inside the hours but not a working day. A `day()` of 0 compared against
    // an ISO list would make this true, and Monday false.
    expect(isWorkingTime(at('2026-06-14T11:00:00Z'), HOURS)).toBe(false);
    expect(isWorkingTime(at('2026-06-15T11:00:00Z'), HOURS)).toBe(true);
  });
});
