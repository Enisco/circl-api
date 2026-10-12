import { BreakdownChart, Chart, KpiChart, MatrixChart, TableChart } from '../chart.types';
import { suppressChart, suppressEverything } from '../suppression';

const kpi = (value: number | null, previous: number | null = null): KpiChart => ({
  kind: 'kpi',
  value,
  previous,
  changePct: 50,
  unit: 'members',
  sparkline: [
    { t: '2026-03-01', v: 3 },
    { t: '2026-03-02', v: 40 },
    { t: '2026-03-03', v: 0 },
  ],
});

/**
 * Suppression is the rule that keeps a demographics page from naming somebody. The cases that
 * matter are not "is 3 hidden" — they are the ways a hidden number can be worked back out: from a
 * total minus the visible cells, from a percentage change, or from a sparkline the headline was
 * taken off.
 */
describe('suppressChart', () => {
  describe('what the magnitude floor applies to', () => {
    /**
     * Not a KPI headline. §2.7 suppresses "member KPIs when the filtered **population** is < 10",
     * which is the population floor applied once for the whole response — a platform of eighty
     * members is not a disclosure because the daily average happens to be three.
     */
    it('leaves a headline member total alone, however small', () => {
      const result = suppressChart(kpi(3)) as KpiChart;

      expect(result.value).toBe(3);
      expect(result.suppressed).toBeUndefined();
    });

    it('but withholds each sparkline point — one day is a handful of people', () => {
      const result = suppressChart(kpi(40)) as KpiChart;

      expect(result.sparkline.map(point => point.v)).toEqual([null, 40, 0]);
      expect(result.sparkline[0].suppressed).toBe(true);
    });

    it('shows zero in a sparkline — zero identifies nobody', () => {
      const result = suppressChart(kpi(40)) as KpiChart;

      expect(result.sparkline[2]).toEqual({ t: '2026-03-03', v: 0 });
    });

    /**
     * A ratio is never itself a count of people, so comparing it to a floor of ten is a category
     * error: every stickiness and every single-digit percentage would vanish. §2.7's real rule is
     * "ratios derived from suppressed counts", which only the code that divided them knows — so
     * `stickiness` is nulled where MAU is small, in the analytics.
     */
    it('leaves a ratio alone, because 0.2 is not "fewer than ten people"', () => {
      const stickiness: Chart = { ...kpi(0.2), unit: 'ratio' };

      expect(suppressChart(stickiness)).toMatchObject({ value: 0.2 });
    });

    it('and a percentage', () => {
      const rate: Chart = { ...kpi(5), unit: 'percent' };

      expect(suppressChart(rate)).toMatchObject({ value: 5 });
    });

    it('and a count of things rather than of people', () => {
      const requests: Chart = { ...kpi(3), unit: 'count' };

      expect(suppressChart(requests)).toMatchObject({ value: 3, sparkline: kpi(3).sparkline });
    });
  });

  describe('breakdowns', () => {
    const breakdown = (values: number[]): BreakdownChart => ({
      kind: 'breakdown',
      unit: 'members',
      total: values.reduce((sum, value) => sum + value, 0),
      items: values.map((value, index) => ({
        key: `k${index}`,
        label: `k${index}`,
        value,
        share: 0.5,
      })),
    });

    it('withholds the small cells', () => {
      // Two small ones, so the complementary rule below has nothing left to add and this case is
      // about the floor alone.
      const result = suppressChart(breakdown([50, 40, 3, 2])) as BreakdownChart;

      expect(result.items.map(item => item.value)).toEqual([50, 40, null, null]);
    });

    it('drops the share of a withheld cell, which is the value divided by a visible total', () => {
      const result = suppressChart(breakdown([50, 40, 3])) as BreakdownChart;

      expect(result.items[2].share).toBeNull();
    });

    it('also withholds the next smallest when exactly one cell is hidden', () => {
      // 93 total, 50 and 40 shown: the hidden 3 is subtraction away. So 40 goes too.
      const result = suppressChart(breakdown([50, 40, 3])) as BreakdownChart;

      expect(result.items.map(item => item.value)).toEqual([50, null, null]);
    });

    it('does not need the complementary rule when two are already hidden', () => {
      const result = suppressChart(breakdown([50, 40, 3, 2])) as BreakdownChart;

      expect(result.items.map(item => item.value)).toEqual([50, 40, null, null]);
    });

    it('withholds `other` when it is small', () => {
      const chart: BreakdownChart = { ...breakdown([50, 40]), other: 4 };

      expect(suppressChart(chart)).toMatchObject({ other: null });
    });
  });

  describe('matrices', () => {
    it('withholds small cells and lists their coordinates for the portal to shade', () => {
      const matrix: MatrixChart = {
        kind: 'matrix',
        unit: 'members',
        rows: [{ key: 'r0', label: 'r0' }],
        cols: [
          { key: 'c0', label: 'c0' },
          { key: 'c1', label: 'c1' },
        ],
        cells: [[40, 2]],
        suppressed: [],
      };

      const result = suppressChart(matrix) as MatrixChart;

      expect(result.cells).toEqual([[40, null]]);
      expect(result.suppressed).toEqual([[0, 1]]);
    });
  });

  /**
   * A table is the one shape whose unit is per-column, so it is the one shape the floor can miss
   * entirely — and did. `topGuides` carries a `uniqueReaders` column of member counts and shipped
   * showing "3".
   */
  describe('tables', () => {
    const guides = (readers: number): TableChart => ({
      kind: 'table',
      columns: [
        { key: 'title', label: 'Title' },
        { key: 'reads', label: 'Reads', unit: 'count' },
        { key: 'uniqueReaders', label: 'Readers', unit: 'members' },
      ],
      rows: [{ title: 'Renting in Leeds', reads: 48, uniqueReaders: readers }],
    });

    it('withholds a member count below the floor', () => {
      expect((suppressChart(guides(3)) as TableChart).rows[0]).toEqual({
        title: 'Renting in Leeds',
        reads: 48,
        uniqueReaders: null,
      });
    });

    it('leaves the other columns of that row alone', () => {
      // The row stays readable: it is the count of people that is withheld, not the guide.
      const row = (suppressChart(guides(3)) as TableChart).rows[0];

      expect(row.title).toBe('Renting in Leeds');
      expect(row.reads).toBe(48);
    });

    it('leaves a member count at the floor alone', () => {
      expect((suppressChart(guides(10)) as TableChart).rows[0].uniqueReaders).toBe(10);
    });

    it('leaves zero alone, because zero names nobody', () => {
      expect((suppressChart(guides(0)) as TableChart).rows[0].uniqueReaders).toBe(0);
    });

    it('leaves a table with no member column untouched, including small counts', () => {
      const shops: TableChart = {
        kind: 'table',
        columns: [
          { key: 'name', label: 'Name' },
          { key: 'enquiries', label: 'Enquiries', unit: 'count' },
        ],
        rows: [{ name: 'Mama Put', enquiries: 2 }],
      };

      expect(suppressChart(shops)).toBe(shops);
    });

    it('ignores a cell that is not a number, rather than nulling it', () => {
      const odd: TableChart = {
        kind: 'table',
        columns: [{ key: 'uniqueReaders', label: 'Readers', unit: 'members' }],
        rows: [{ uniqueReaders: null }, { uniqueReaders: '4' }],
      };

      expect((suppressChart(odd) as TableChart).rows).toEqual([
        { uniqueReaders: null },
        { uniqueReaders: '4' },
      ]);
    });
  });

  describe('groups', () => {
    it('reaches inside, because a KPI group is where the sparklines live', () => {
      const group: Chart = { kind: 'group', items: { a: kpi(3), b: kpi(40) } };
      const result = suppressChart(group) as { kind: 'group'; items: Record<string, KpiChart> };

      // Headlines kept, each inner sparkline suppressed — a group is not a chart of its own, so
      // walking it has to apply the same rules to what it holds.
      expect(result.items.a.value).toBe(3);
      expect(result.items.a.sparkline.map(point => point.v)).toEqual([null, 40, 0]);
      expect(result.items.b.sparkline[0].suppressed).toBe(true);
    });

    it('applies a group member\u2019s own unit, not the group\u2019s', () => {
      const group: Chart = {
        kind: 'group',
        items: { members: kpi(3), rate: { ...kpi(0.2), unit: 'ratio' } },
      };
      const result = suppressChart(group) as { kind: 'group'; items: Record<string, KpiChart> };

      expect(result.items.members.sparkline[0].v).toBeNull();
      // A ratio's sparkline is not a count of people either.
      expect(result.items.rate.sparkline[0].v).toBe(3);
    });
  });
});

describe('suppressEverything (the population floor)', () => {
  it('blanks a count of things, not only counts of members', () => {
    // With four people selected, "7 requests" is still about four identifiable people.
    const charts = {
      requests: { ...kpi(7), unit: 'count' as const },
      cities: {
        kind: 'breakdown' as const,
        unit: 'count' as const,
        total: 7,
        items: [{ key: 'LONDON', label: 'London', value: 7, share: 1 }],
      },
    };

    const result = suppressEverything(charts);

    expect(result.requests).toMatchObject({ value: null, suppressed: true });
    expect(result.cities).toMatchObject({ total: null });
    expect((result.cities as BreakdownChart).items[0]).toMatchObject({
      value: null,
      share: null,
      suppressed: true,
    });
  });

  it('empties a sparkline rather than leaving nulls that still show its length', () => {
    expect(suppressEverything({ a: kpi(7) }).a).toMatchObject({ sparkline: [] });
  });

  /**
   * The rows go entirely. A table's non-numeric columns are the disclosure as much as its numbers:
   * under the floor, a guide title or a search term is a fact about one of fewer than ten people.
   */
  it('drops a table\u2019s rows and says it did, keeping the header', () => {
    const table: TableChart = {
      kind: 'table',
      columns: [
        { key: 'term', label: 'Term' },
        { key: 'searches', label: 'Searches', unit: 'count' },
      ],
      rows: [{ term: 'immigration solicitor', searches: 4 }],
    };

    expect(suppressEverything({ t: table }).t).toEqual({
      kind: 'table',
      columns: table.columns,
      rows: [],
      suppressed: true,
    });
  });

  it('marks every matrix cell as withheld', () => {
    const matrix: MatrixChart = {
      kind: 'matrix',
      unit: 'members',
      rows: [{ key: 'r', label: 'r' }],
      cols: [
        { key: 'a', label: 'a' },
        { key: 'b', label: 'b' },
      ],
      cells: [[1, 2]],
      suppressed: [],
    };

    expect(suppressEverything({ m: matrix }).m).toMatchObject({
      cells: [[null, null]],
      suppressed: [
        [0, 0],
        [0, 1],
      ],
    });
  });
});
