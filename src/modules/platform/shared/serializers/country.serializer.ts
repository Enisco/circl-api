/**
 * Countries come from ICU, not from a list anybody maintains.
 *
 * A curated vocabulary of the countries we expected our members to come from was wrong the first
 * time somebody arrived from one that was not on it, and the only honest way to be complete is to
 * take the whole set. `Intl.DisplayNames` ships with Node and knows every region code, so there is
 * nothing to seed, nothing to keep in step with the app, and no country missing.
 */

/** The aggregates ICU returns alongside real countries. Nobody is from the Eurozone. */
const NOT_A_COUNTRY = new Set(['EU', 'EZ', 'UN', 'QO', 'XA', 'XB', 'ZZ']);

const display = new Intl.DisplayNames(['en'], { type: 'region' });

/** Built once: every alpha-2 pair ICU gives a name to, which is the ISO list without shipping one. */
const COUNTRIES: ReadonlyMap<string, string> = (() => {
  const found = new Map<string, string>();

  for (let first = 65; first <= 90; first += 1) {
    for (let second = 65; second <= 90; second += 1) {
      const code = String.fromCharCode(first) + String.fromCharCode(second);

      if (NOT_A_COUNTRY.has(code)) continue;

      const name = display.of(code);

      // ICU returns the code back when it knows no name for it.
      if (name && name !== code) found.set(code, name);
    }
  }

  return found;
})();

/** The sentinel for a member who would rather not say, which has no code and no flag. */
export const NO_COUNTRY = 'OTHER';

export const isCountryCode = (code: string): boolean => COUNTRIES.has(code.toUpperCase());

export const countryNameOf = (code: string | null | undefined): string | null =>
  code ? (COUNTRIES.get(code.toUpperCase()) ?? null) : null;

/** A country as a term, for the fields that render `{ code, label }`. */
export const toCountryView = (
  code: string | null | undefined,
): { code: string; label: string } | null => {
  if (!code || code === NO_COUNTRY) return null;

  const label = countryNameOf(code);

  return label ? { code: code.toUpperCase(), label } : null;
};

/**
 * A country name back to its code, for the client that still sends "Nigeria" where `NG` belongs.
 * Built lazily because most requests never need it.
 */
let byName: Map<string, string> | null = null;

export const countryCodeFromName = (value: string): string | null => {
  const needle = value.trim().toLowerCase();

  if (!needle) return null;
  if (COUNTRIES.has(value.toUpperCase())) return value.toUpperCase();

  byName ??= new Map([...COUNTRIES].map(([code, name]) => [name.toLowerCase(), code]));

  return byName.get(needle) ?? null;
};
