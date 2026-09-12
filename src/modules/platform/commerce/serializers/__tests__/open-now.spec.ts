import { StoreStatus, Weekday } from '@prisma/client';
import { isOpenNow, toOpeningHours } from '../store.serializer';

/**
 * September is BST, so these are an hour ahead in London: 10:00 UTC is 11:00 local and 00:30 UTC is
 * 01:30. Stated in UTC because that is what a Date holds, and named for what London reads.
 */
const WEDNESDAY_11AM_LOCAL = new Date('2026-09-09T10:00:00Z');
const WEDNESDAY_0130_LOCAL = new Date('2026-09-09T00:30:00Z');

const week = (overrides: Partial<Record<Weekday, [number, number]>>) =>
  toOpeningHours(
    Object.entries(overrides).map(([day, [openMinutes, closeMinutes]]) => ({
      day: day as Weekday,
      openMinutes,
      closeMinutes,
    })),
  );

describe('isOpenNow', () => {
  it('answers the manual switch before the clock', () => {
    const hours = week({ WEDNESDAY: [540, 1080] });

    expect(isOpenNow(StoreStatus.HOLIDAY, 'Europe/London', hours, WEDNESDAY_11AM_LOCAL)).toBe(
      false,
    );
    expect(isOpenNow(StoreStatus.CLOSED, 'Europe/London', hours, WEDNESDAY_11AM_LOCAL)).toBe(false);
  });

  // Filling the absent days with nulls made every shop that keeps no hours read as shut every day,
  // which is a claim none of them made, and it emptied the "Open now" filter of the whole database.
  it('takes a shop that keeps no hours at its word', () => {
    expect(isOpenNow(StoreStatus.OPEN, 'Europe/London', null, WEDNESDAY_11AM_LOCAL)).toBe(true);
    expect(isOpenNow(StoreStatus.OPEN, 'Europe/London', [], WEDNESDAY_11AM_LOCAL)).toBe(true);
  });

  it('reads the window when there is one', () => {
    expect(
      isOpenNow(
        StoreStatus.OPEN,
        'Europe/London',
        week({ WEDNESDAY: [540, 1080] }),
        WEDNESDAY_11AM_LOCAL,
      ),
    ).toBe(true);
    expect(
      isOpenNow(
        StoreStatus.OPEN,
        'Europe/London',
        week({ WEDNESDAY: [780, 1080] }),
        WEDNESDAY_11AM_LOCAL,
      ),
    ).toBe(false);
  });

  it('is closed on a day it keeps no hours, even in a week that has some', () => {
    expect(
      isOpenNow(
        StoreStatus.OPEN,
        'Europe/London',
        week({ MONDAY: [540, 1080] }),
        WEDNESDAY_11AM_LOCAL,
      ),
    ).toBe(false);
  });

  // 6pm to 2am is a real bar, and an am/pm slip in a time picker has the same shape. Refusing it
  // would be wrong, so it is read as trading past midnight either way.
  it('carries a day that ends after midnight into the next one', () => {
    // Tuesday 6pm to 2am. At 01:30 on Wednesday the bar is still Tuesday's.
    const lateBar = week({ TUESDAY: [1080, 120] });

    expect(isOpenNow(StoreStatus.OPEN, 'Europe/London', lateBar, WEDNESDAY_0130_LOCAL)).toBe(true);
    expect(isOpenNow(StoreStatus.OPEN, 'Europe/London', lateBar, WEDNESDAY_11AM_LOCAL)).toBe(false);
  });
});

describe('toOpeningHours', () => {
  it('returns null for a shop that keeps none, rather than seven closed days', () => {
    expect(toOpeningHours([])).toBeNull();
  });

  it('returns seven, Monday first, each naming its day', () => {
    const hours = week({ WEDNESDAY: [540, 1080] })!;

    expect(hours).toHaveLength(7);
    expect(hours[0].day).toBe(Weekday.MONDAY);
    expect(hours.map(row => row.day)).toEqual([
      'MONDAY',
      'TUESDAY',
      'WEDNESDAY',
      'THURSDAY',
      'FRIDAY',
      'SATURDAY',
      'SUNDAY',
    ]);
  });

  it('fills a day it was given nothing for as closed', () => {
    const hours = week({ WEDNESDAY: [540, 1080] })!;

    expect(hours[0].openMinutes).toBeNull();
    expect(hours[2].openMinutes).toBe(540);
  });
});
