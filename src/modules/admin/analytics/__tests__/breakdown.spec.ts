import { BreakdownChart } from '../chart.types';
import { toBreakdown, toMatrix } from '../breakdown';

const rows = (entries: Array<[string | null, number]>) =>
  entries.map(([key, total]) => ({ key, total }));

/**
 * The fiddly parts every tab repeats, which is why they live in one helper: a null key is a group
 * and not a gap, `other` is the sum of what was dropped, a vocabulary with an order keeps it, and
 * the shares are over the right denominator. Each of those is somewhere to be quietly wrong.
 */
describe('toBreakdown', () => {
  it('sorts by size and shares over the summed total', () => {
    const chart = toBreakdown(
      rows([
        ['a', 10],
        ['b', 30],
      ]),
    );

    expect(chart.total).toBe(40);
    expect(chart.items.map(item => item.key)).toEqual(['b', 'a']);
    expect(chart.items[0].share).toBe(0.75);
  });

  it('treats a null key as a labelled group rather than a gap', () => {
    const chart = toBreakdown(
      rows([
        [null, 5],
        ['a', 1],
      ]),
      { unknownLabel: 'Not said' },
    );

    expect(chart.items.find(item => item.key === 'UNKNOWN')?.label).toBe('Not said');
  });

  it('keeps a vocabulary value nobody has chosen, at zero', () => {
    const chart = toBreakdown(rows([['b', 3]]), { order: ['a', 'b', 'c'] });

    expect(chart.items.map(item => [item.key, item.value])).toEqual([
      ['a', 0],
      ['b', 3],
      ['c', 0],
    ]);
  });

  it('puts a value the vocabulary does not know about after it, largest first', () => {
    const chart = toBreakdown(
      rows([
        ['a', 1],
        ['z', 9],
        ['y', 4],
      ]),
      { order: ['a'] },
    );

    expect(chart.items.map(item => item.key)).toEqual(['a', 'z', 'y']);
  });

  describe('`other`', () => {
    it('is the sum of the groups that were dropped', () => {
      const chart = toBreakdown(
        rows([
          ['a', 50],
          ['b', 40],
          ['c', 3],
          ['d', 2],
        ]),
        { top: 2 },
      );

      expect(chart.items.map(item => item.key)).toEqual(['a', 'b']);
      expect(chart.other).toBe(5);
    });

    it('is absent when nothing was dropped', () => {
      expect(toBreakdown(rows([['a', 1]]), { top: 5 }).other).toBeUndefined();
    });

    /**
     * The multi-valued case. A member holding four interests is counted in four groups, so a sum
     * of the dropped groups is not comparable to a member count — it can exceed the total outright,
     * and a bar reading "other: 120 of 80 members" is worse than no bar at all.
     */
    it('is omitted where the denominator was overridden, because the groups overlap', () => {
      const chart = toBreakdown(
        rows([
          ['a', 70],
          ['b', 60],
          ['c', 50],
          ['d', 40],
        ]),
        { top: 2, total: 80 },
      );

      expect(chart.total).toBe(80);
      expect(chart.other).toBeUndefined();
    });

    it('and the shares are fractions of that denominator, which may sum above one', () => {
      const chart = toBreakdown(
        rows([
          ['a', 70],
          ['b', 60],
        ]),
        { total: 80 },
      );
      const shares = chart.items.map(item => item.share ?? 0);

      expect(shares).toEqual([0.875, 0.75]);
      expect(shares.reduce((sum, share) => sum + share, 0)).toBeGreaterThan(1);
    });
  });

  /**
   * `top` decides by size even when an order is given. Decided by the order instead, `other` would
   * hold whatever happened to be late in the vocabulary rather than the groups too small to show.
   */
  it('names the biggest groups when an order and a cap are combined', () => {
    const chart = toBreakdown(
      rows([
        ['first', 1],
        ['second', 2],
        ['third', 90],
      ]),
      { order: ['first', 'second', 'third'], top: 1 },
    );

    expect(chart.items.map(item => item.key)).toEqual(['third']);
    expect(chart.other).toBe(3);
  });

  describe('a non-additive measure', () => {
    /**
     * Medians, response times, averages. Summing them gives a number that means nothing, and
     * dividing by it gives a "share" of minutes — which invites a reader to conclude that one
     * profession takes up a third of everybody's waiting. No total is better than a wrong one.
     */
    it('reports no total and no shares', () => {
      const chart = toBreakdown(
        rows([
          ['a', 280],
          ['b', 215],
        ]),
        {
          unit: 'minutes',
          additive: false,
        },
      );

      expect(chart.total).toBeNull();
      expect(chart.items.map(item => item.share)).toEqual([null, null]);
    });

    it('but keeps the values, ordered by size', () => {
      const chart = toBreakdown(
        rows([
          ['a', 215],
          ['b', 280],
        ]),
        { additive: false },
      );

      expect(chart.items.map(item => [item.key, item.value])).toEqual([
        ['b', 280],
        ['a', 215],
      ]);
    });

    it('and no `other`, because a residual of medians is not a median either', () => {
      const chart = toBreakdown(
        rows([
          ['a', 90],
          ['b', 80],
          ['c', 70],
        ]),
        {
          additive: false,
          top: 2,
        },
      );

      expect(chart.other).toBeUndefined();
    });
  });

  it('gives a share of null rather than dividing by nothing', () => {
    const chart: BreakdownChart = toBreakdown(rows([['a', 0]]));

    expect(chart.total).toBe(0);
    expect(chart.items[0].share).toBeNull();
  });

  it('folds duplicate keys together rather than emitting two rows', () => {
    const chart = toBreakdown(
      rows([
        ['a', 2],
        ['a', 3],
      ]),
    );

    expect(chart.items).toHaveLength(1);
    expect(chart.items[0].value).toBe(5);
  });
});

describe('toMatrix', () => {
  const axes = {
    rows: [
      { key: 'r1', label: 'R1' },
      { key: 'r2', label: 'R2' },
    ],
    cols: [
      { key: 'c1', label: 'C1' },
      { key: 'c2', label: 'C2' },
    ],
  };

  it('fills every declared cell, present or not', () => {
    const chart = toMatrix([{ row: 'r1', col: 'c2', total: 7 }], axes);

    expect(chart.cells).toEqual([
      [0, 7],
      [0, 0],
    ]);
  });

  it('files a null row or column under UNKNOWN, so it is not silently dropped', () => {
    const chart = toMatrix([{ row: null, col: 'c1', total: 4 }], {
      rows: [{ key: 'UNKNOWN', label: 'Not said' }],
      cols: axes.cols,
    });

    expect(chart.cells).toEqual([[4, 0]]);
  });

  it('ignores a cell outside the declared axes rather than inventing a row for it', () => {
    const chart = toMatrix([{ row: 'nope', col: 'c1', total: 9 }], axes);

    expect(chart.cells).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });
});
