/** A code plus its label (spec 0.7). */
export interface TermView {
  code: string;
  label: string;
}

export const toTermView = (
  code: string | null | undefined,
  labels: Map<string, string>,
): TermView | null => (code ? { code, label: labels.get(code) ?? humanise(code) } : null);

/** The fallback when a code has no seeded label. */
export const humanise = (code: string): string =>
  code
    .toLowerCase()
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
