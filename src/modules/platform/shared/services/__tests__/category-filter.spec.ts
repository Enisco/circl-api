import { isAllCategories, withoutAllCategories } from '../category-filter';

describe('the All category sentinel', () => {
  // The pickers send the word instead of omitting the parameter. Read as a code it matches no
  // listing, and the screen comes back empty with an empty widen hint beside it.
  it.each(['All', 'ALL', 'all', ' All '])('reads %p as every category', value => {
    expect(isAllCategories(value)).toBe(true);
  });

  it('leaves a real code alone', () => {
    expect(isAllCategories('IMMIGRATION')).toBe(false);
    expect(isAllCategories('ALL_TRADES')).toBe(false);
  });

  it('drops the sentinel from a multi-select and keeps the rest', () => {
    expect(withoutAllCategories(['All', 'IMMIGRATION'])).toEqual(['IMMIGRATION']);
    expect(withoutAllCategories(['All'])).toEqual([]);
    expect(withoutAllCategories([])).toEqual([]);
  });
});
