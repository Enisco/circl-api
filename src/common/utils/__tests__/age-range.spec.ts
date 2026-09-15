import { ageFromDateOfBirth, birthDateRangeForAges } from '../date.util';

/**
 * The range has to select exactly the people the derived age would have selected, or a count and a
 * grid describe different sets — which is what filtering in memory after the query did.
 */
describe('birthDateRangeForAges', () => {
  const now = new Date('2026-09-15T12:00:00.000Z');

  /** Every birth date from 60 years ago to today, one a week. */
  const candidates = (): Date[] => {
    const days: Date[] = [];

    for (let week = 0; week < 60 * 52; week += 1) {
      days.push(new Date(now.getTime() - week * 7 * 24 * 60 * 60 * 1000));
    }

    return days;
  };

  const inRange = (date: Date, range: { earliest?: Date; latest?: Date }): boolean =>
    (range.earliest === undefined || date > range.earliest) &&
    (range.latest === undefined || date <= range.latest);

  const ageAt = (date: Date): number => {
    let age = now.getUTCFullYear() - date.getUTCFullYear();
    const months = now.getUTCMonth() - date.getUTCMonth();

    if (months < 0 || (months === 0 && now.getUTCDate() < date.getUTCDate())) age -= 1;

    return age;
  };

  it.each([
    [18, 24],
    [25, 34],
    [35, 44],
    [45, undefined],
    [undefined, 30],
    [undefined, undefined],
  ])('selects exactly the ages %s to %s', (min, max) => {
    const range = birthDateRangeForAges(min, max, now);
    const wrong = candidates().filter(date => {
      const age = ageAt(date);
      const wanted = (min === undefined || age >= min) && (max === undefined || age <= max);

      return inRange(date, range) !== wanted;
    });

    expect(wrong).toEqual([]);
  });

  it('includes both ends of a band, which is what the pill says', () => {
    const range = birthDateRangeForAges(25, 34, now);
    const exactly25 = new Date('2001-09-15T12:00:00.000Z');
    const exactly34 = new Date('1992-09-15T12:00:00.000Z');

    expect(ageAt(exactly25)).toBe(25);
    expect(ageAt(exactly34)).toBe(34);
    expect(inRange(exactly25, range)).toBe(true);
    expect(inRange(exactly34, range)).toBe(true);
  });

  it('and agrees with the age the API reports', () => {
    // The same function the profile view uses, so a card cannot show an age the filter excluded.
    const birthday = new Date();

    birthday.setUTCFullYear(birthday.getUTCFullYear() - 30);

    const range = birthDateRangeForAges(30, 30);

    expect(ageFromDateOfBirth(birthday)).toBe(30);
    expect(inRange(birthday, range)).toBe(true);
  });
});
