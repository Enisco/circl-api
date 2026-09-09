/**
 * The pickers' "no filter" option, the taxonomy twin of `ANYWHERE` for cities. The apps send the
 * word rather than omitting the parameter, and read as a code it matches nothing at all.
 */
export const ALL_CATEGORIES = 'ALL';

export const isAllCategories = (value: string): boolean =>
  value.trim().toUpperCase() === ALL_CATEGORIES;

/** Drops the sentinel from a multi-select, leaving an empty list to mean no filter. */
export const withoutAllCategories = (values: string[]): string[] =>
  values.filter(value => !isAllCategories(value));
