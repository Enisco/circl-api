import {
  dateOnlySpan,
  londonCalendarDay,
  londonDateString,
  londonMidnight,
  shiftDateOnly,
} from '../date.util';

/**
 * Every bucket, boundary and "today" in the admin portal is London-local (§2.6), and the whole
 * reason these helpers exist is the two days a year the offset changes. A one-hour error on a range
 * boundary moves rows between buckets, which shows up as a chart that disagrees with a list.
 */
describe('London calendar dates', () => {
  describe('londonMidnight', () => {
    it('is the same instant as UTC midnight in winter', () => {
      expect(londonMidnight('2026-01-15').toISOString()).toBe('2026-01-15T00:00:00.000Z');
    });

    it('is an hour before UTC midnight in British Summer Time', () => {
      expect(londonMidnight('2026-07-15').toISOString()).toBe('2026-07-14T23:00:00.000Z');
    });

    it('handles the day the clocks go forward, when the day is 23 hours long', () => {
      // BST begins at 01:00 on 29 March 2026. Midnight that day is still GMT.
      expect(londonMidnight('2026-03-29').toISOString()).toBe('2026-03-29T00:00:00.000Z');
      // And the next midnight is an hour earlier in UTC, so the day covered 23 hours.
      expect(londonMidnight('2026-03-30').toISOString()).toBe('2026-03-29T23:00:00.000Z');
    });

    it('handles the day the clocks go back, when the day is 25 hours long', () => {
      // BST ends at 02:00 on 25 October 2026.
      expect(londonMidnight('2026-10-25').toISOString()).toBe('2026-10-24T23:00:00.000Z');
      expect(londonMidnight('2026-10-26').toISOString()).toBe('2026-10-26T00:00:00.000Z');
    });

    it('refuses something that is not a calendar date', () => {
      expect(() => londonMidnight('not-a-date')).toThrow(TypeError);
    });
  });

  describe('londonDateString', () => {
    it('files 23:30 on a summer evening under that day, not the next one', () => {
      // 22:30 UTC on 5 July is 23:30 in London on the 5th. `toISOString().slice(0, 10)` agrees
      // here; the next case is the one that does not.
      expect(londonDateString(new Date('2026-07-05T22:30:00Z'))).toBe('2026-07-05');
    });

    it('files 00:30 London on the 6th under the 6th, where the UTC reading says the 5th', () => {
      expect(londonDateString(new Date('2026-07-05T23:30:00Z'))).toBe('2026-07-06');
    });
  });

  describe('londonCalendarDay', () => {
    it('is the London day as a UTC-midnight value, which is what a date column holds', () => {
      expect(londonCalendarDay(new Date('2026-07-05T23:30:00Z')).toISOString()).toBe(
        '2026-07-06T00:00:00.000Z',
      );
    });
  });

  describe('shiftDateOnly', () => {
    it('shifts whole calendar days across a clock change', () => {
      expect(shiftDateOnly('2026-03-28', 1)).toBe('2026-03-29');
      expect(shiftDateOnly('2026-10-25', -1)).toBe('2026-10-24');
    });

    it('crosses a month and a year', () => {
      expect(shiftDateOnly('2026-12-31', 1)).toBe('2027-01-01');
      expect(shiftDateOnly('2026-01-01', -1)).toBe('2025-12-31');
    });
  });

  describe('dateOnlySpan', () => {
    it('counts both ends', () => {
      expect(dateOnlySpan('2026-01-01', '2026-01-01')).toBe(1);
      expect(dateOnlySpan('2026-01-01', '2026-01-30')).toBe(30);
    });

    it('is unaffected by a clock change inside the range', () => {
      expect(dateOnlySpan('2026-03-28', '2026-03-30')).toBe(3);
      expect(dateOnlySpan('2026-10-24', '2026-10-26')).toBe(3);
    });
  });
});
