import { DEAL_FLOOR, MoneyRow, collapseToFloor } from '../deals.analytics';

/**
 * The `byProfession` collapse rule (addendum §5).
 *
 * Iterative, which is why it is worth testing directly: each move changes which category is now
 * the smallest, and the rule it enforces is that **every row returned is built from at least ten
 * deals**. Get it wrong and a row of three deals appears with a category label on it, or a
 * residual too small to show is left for somebody to subtract their way into.
 */
const group = (
  code: string | null,
  deals: number,
  amount = 1_000,
): MoneyRow & { code: string | null } => ({
  code,
  deals_agreed: deals,
  open_deals: deals,
  done_deals: 0,
  agreed_value: BigInt(deals * amount),
  recorded_paid: 0n,
  outstanding: BigInt(deals * amount),
  completed_value: 0n,
  median_value: BigInt(amount),
});

describe('collapseToFloor', () => {
  it('gives no table at all below the floor — any row would be one small group with a label', () => {
    expect(collapseToFloor([group('LAW', 9)])).toBeNull();
    expect(collapseToFloor([group('LAW', 5), group('TAX', 4)])).toBeNull();
  });

  it('keeps every category that reaches the floor, largest first', () => {
    const rows = collapseToFloor([group('LAW', 12), group('TAX', 30)])!;

    expect(rows.map(row => row.code)).toEqual(['TAX', 'LAW']);
  });

  it('puts the small categories into one "Other categories" row', () => {
    const rows = collapseToFloor([
      group('TAX', 30),
      group('LAW', 12),
      group('HAIR', 6),
      group('MOVING', 5),
    ])!;

    expect(rows.map(row => row.label)).toEqual(['TAX', 'LAW', 'Other categories']);
    expect(rows[2].row.deals_agreed).toBe(11);
  });

  /**
   * The iterative part. The residual starts below the floor, so the smallest shown category joins
   * it — and only then does it clear.
   */
  it('takes from the smallest shown category when the residual is short', () => {
    const rows = collapseToFloor([group('TAX', 30), group('LAW', 12), group('HAIR', 3)])!;

    expect(rows.map(row => row.label)).toEqual(['TAX', 'Other categories']);
    // LAW's twelve joined HAIR's three.
    expect(rows[1].row.deals_agreed).toBe(15);
  });

  it('repeats until the residual clears the floor', () => {
    const rows = collapseToFloor([group('A', 11), group('B', 11), group('C', 1)])!;

    // C alone is 1; it takes B to reach 12.
    expect(rows.map(row => row.label)).toEqual(['A', 'Other categories']);
    expect(rows[1].row.deals_agreed).toBe(12);
  });

  it('collapses to a single "All categories" row when no category reaches the floor', () => {
    const rows = collapseToFloor([group('A', 4), group('B', 4), group('C', 4)])!;

    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('All categories');
    expect(rows[0].code).toBeNull();
    expect(rows[0].row.deals_agreed).toBe(12);
  });

  it('files providers with no listing category under the residual', () => {
    const rows = collapseToFloor([group('TAX', 20), group(null, 11)])!;

    expect(rows.map(row => row.label)).toEqual(['TAX', 'Other categories']);
    expect(rows[1].row.deals_agreed).toBe(11);
  });

  it('emits no residual row when there is nothing left over', () => {
    const rows = collapseToFloor([group('TAX', 20), group('LAW', 15)])!;

    expect(rows).toHaveLength(2);
    expect(rows.some(row => row.code === null)).toBe(false);
  });

  it('never returns a row built from fewer than ten deals', () => {
    const shapes: Array<Array<MoneyRow & { code: string | null }>> = [
      [group('A', 10)],
      [group('A', 10), group('B', 1)],
      [group('A', 10), group('B', 9), group('C', 9)],
      [group('A', 3), group('B', 3), group('C', 3), group('D', 3)],
      [group('A', 40), group('B', 11), group(null, 2)],
    ];

    for (const rows of shapes) {
      for (const row of collapseToFloor(rows) ?? []) {
        expect(row.row.deals_agreed).toBeGreaterThanOrEqual(DEAL_FLOOR);
      }
    }
  });

  it('sums the money of every group it merges', () => {
    const rows = collapseToFloor([group('A', 20, 500), group('B', 6, 500), group('C', 6, 500)])!;

    expect(Number(rows[1].row.agreed_value)).toBe(12 * 500);
  });

  /** A median of medians is not a median, so a merged row reports none. */
  it('drops the median of a merged row', () => {
    const rows = collapseToFloor([group('A', 20, 500), group('B', 6), group('C', 6)])!;

    expect(Number(rows[1].row.median_value)).toBe(0);
    expect(Number(rows[0].row.median_value)).toBe(500);
  });
});
