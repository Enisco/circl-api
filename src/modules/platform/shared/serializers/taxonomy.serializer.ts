/**
 * A code plus its label (spec 0.7).
 *
 * The client stores and filters on `code` and renders `label`. This is the single
 * most important convention in the document: display strings are UI copy, they
 * get reworded and translated, and if they are also the database values then
 * every rewording is a migration and a broken filter.
 */
export interface TermView {
  code: string;
  label: string;
}

export const toTermView = (
  code: string | null | undefined,
  labels: Map<string, string>,
): TermView | null => (code ? { code, label: labels.get(code) ?? humanise(code) } : null);

/**
 * The fallback when a code has no seeded label. Better than sending the raw code
 * to a screen, and visible enough in QA that the missing seed gets noticed.
 */
export const humanise = (code: string): string =>
  code
    .toLowerCase()
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
