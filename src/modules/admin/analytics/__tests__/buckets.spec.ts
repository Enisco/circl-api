import { bucketsFor, indexByDay } from '../buckets';

/**
 * Bucket boundaries are where a chart quietly starts disagreeing with a list. Every case here is a
 * boundary somebody gets wrong once: the week that starts mid-range, the month with 28 days, and
 * the two days a year a London day is not 24 hours long.
 */
describe('bucketsFor', () => {
  it('gives one bucket per day', () => {
    const buckets = bucketsFor('2026-03-01', '2026-03-05', 'day');

    expect(buckets.map(bucket => bucket.key)).toEqual([
      '2026-03-01',
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
    ]);
  });

  it('closes each daily bucket at the next London midnight', () => {
    const [bucket] = bucketsFor('2026-07-01', '2026-07-01', 'day');

    // July is BST, so both boundaries are an hour before UTC midnight.
    expect(bucket.from.toISOString()).toBe('2026-06-30T23:00:00.000Z');
    expect(bucket.to.toISOString()).toBe('2026-07-01T23:00:00.000Z');
  });

  it('spans the day the clocks go forward, which is 23 hours long', () => {
    const [bucket] = bucketsFor('2026-03-29', '2026-03-29', 'day');

    expect(bucket.from.toISOString()).toBe('2026-03-29T00:00:00.000Z');
    expect(bucket.to.toISOString()).toBe('2026-03-29T23:00:00.000Z');
  });

  it('spans the day the clocks go back, which is 25 hours long', () => {
    const [bucket] = bucketsFor('2026-10-25', '2026-10-25', 'day');

    expect(bucket.from.toISOString()).toBe('2026-10-24T23:00:00.000Z');
    expect(bucket.to.toISOString()).toBe('2026-10-26T00:00:00.000Z');
  });

  describe('weeks', () => {
    it('start on Monday', () => {
      // 2026-03-02 is a Monday.
      const buckets = bucketsFor('2026-03-02', '2026-03-22', 'week');

      expect(buckets.map(bucket => bucket.key)).toEqual(['2026-03-02', '2026-03-09', '2026-03-16']);
      expect(buckets.map(bucket => bucket.lastDay)).toEqual([
        '2026-03-08',
        '2026-03-15',
        '2026-03-22',
      ]);
    });

    it('give a short first bucket rather than reaching back before the range', () => {
      // 2026-03-04 is a Wednesday. The first bucket must not include the Monday before it: a chart
      // must not show activity from outside the range it says it covers.
      const buckets = bucketsFor('2026-03-04', '2026-03-15', 'week');

      expect(buckets[0]).toMatchObject({ key: '2026-03-04', lastDay: '2026-03-08' });
      expect(buckets[1]).toMatchObject({ key: '2026-03-09', lastDay: '2026-03-15' });
    });

    it('truncate the last bucket at the end of the range', () => {
      const buckets = bucketsFor('2026-03-02', '2026-03-11', 'week');

      expect(buckets[buckets.length - 1]).toMatchObject({
        key: '2026-03-09',
        lastDay: '2026-03-11',
      });
    });

    it('treat Sunday as the seventh day, not the first', () => {
      // 2026-03-08 is a Sunday: its week began on the 2nd, so the bucket starting there is one day
      // long and the next is a full Monday-to-Sunday week.
      const buckets = bucketsFor('2026-03-08', '2026-03-20', 'week');

      expect(buckets[0]).toMatchObject({ key: '2026-03-08', lastDay: '2026-03-08' });
      expect(buckets[1]).toMatchObject({ key: '2026-03-09', lastDay: '2026-03-15' });
      expect(buckets[2]).toMatchObject({ key: '2026-03-16', lastDay: '2026-03-20' });
    });
  });

  describe('months', () => {
    it('end on the real last day, February included', () => {
      const buckets = bucketsFor('2026-01-15', '2026-04-02', 'month');

      expect(buckets.map(bucket => [bucket.key, bucket.lastDay])).toEqual([
        ['2026-01-15', '2026-01-31'],
        ['2026-02-01', '2026-02-28'],
        ['2026-03-01', '2026-03-31'],
        ['2026-04-01', '2026-04-02'],
      ]);
    });

    it('knows a leap February', () => {
      const buckets = bucketsFor('2028-02-01', '2028-03-01', 'month');

      expect(buckets[0].lastDay).toBe('2028-02-29');
    });
  });

  it('covers every day of the range exactly once, at every granularity', () => {
    for (const granularity of ['day', 'week', 'month'] as const) {
      const buckets = bucketsFor('2026-01-01', '2026-06-30', granularity);
      const index = indexByDay(buckets);

      expect(index.size).toBe(181);
      expect(index.get('2026-01-01')).toBe(0);
      expect(index.get('2026-06-30')).toBe(buckets.length - 1);
    }
  });
});

describe('indexByDay', () => {
  it('maps every day of a week onto its bucket', () => {
    const buckets = bucketsFor('2026-03-02', '2026-03-15', 'week');
    const index = indexByDay(buckets);

    expect(index.get('2026-03-02')).toBe(0);
    expect(index.get('2026-03-08')).toBe(0);
    expect(index.get('2026-03-09')).toBe(1);
  });

  it('knows nothing about a day outside the range', () => {
    const index = indexByDay(bucketsFor('2026-03-02', '2026-03-08', 'week'));

    expect(index.get('2026-03-01')).toBeUndefined();
    expect(index.get('2026-03-09')).toBeUndefined();
  });
});
