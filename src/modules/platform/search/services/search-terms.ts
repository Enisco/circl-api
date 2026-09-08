/**
 * Query shaping and in-group ranking, kept out of the service so both are unit testable. A term is
 * expanded before it reaches SQL, and results are ranked in memory over a small window.
 */

/** Longer than this is a paste, not a search, and trigram matching degrades badly on it. */
const MAX_TERM_LENGTH = 64;

/** Below this a term matches most of the corpus, so it is not worth eight queries. */
export const MIN_TERM_LENGTH = 2;

export const normaliseTerm = (raw: string | undefined | null): string =>
  (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TERM_LENGTH);

/** One crude stem, so a plural finds a singular. Short words are left alone. */
export const stemOf = (word: string): string | null => {
  const lower = word.toLowerCase();

  if (lower.endsWith('ies') && lower.length > 4) return `${lower.slice(0, -3)}y`;
  if (lower.endsWith('ing') && lower.length > 5) return lower.slice(0, -3);
  if (lower.endsWith('ed') && lower.length > 4) return lower.slice(0, -2);
  if (lower.endsWith('es') && lower.length > 4) return lower.slice(0, -2);
  if (lower.endsWith('s') && !lower.endsWith('ss') && lower.length > 3) return lower.slice(0, -1);

  return null;
};

/** A phrase is left alone: stemming its last word asks for something nobody wrote. */
export const termVariants = (term: string): string[] => {
  const words = term.split(' ');

  if (words.length !== 1) return [term];

  const stem = stemOf(term);

  return stem && stem !== term.toLowerCase() ? [term, stem] : [term];
};

/** The words of a phrase, for the match-every-word rule that name search uses. */
export const termWords = (term: string): string[] =>
  term.split(' ').filter(word => word.length >= MIN_TERM_LENGTH);

const EXACT = 100;
const PREFIX = 75;
const WORD_PREFIX = 55;
const CONTAINS = 30;

/** How well one piece of text answers the term. Nothing here is fuzzy; SQL already decided the row matched. */
export const textScore = (text: string | null | undefined, term: string): number => {
  if (!text) return 0;

  const haystack = text.toLowerCase();
  const needle = term.toLowerCase();

  if (haystack === needle) return EXACT;
  if (haystack.startsWith(needle)) return PREFIX;
  if (haystack.includes(` ${needle}`)) return WORD_PREFIX;
  if (haystack.includes(needle)) return CONTAINS;

  // It came back from a query that matched something, so it matched a field this scorer cannot
  // see: a description, a bio, a category. Worth keeping, worth ranking last.
  return 0;
};

/** The best score any of the term's forms gets against any of the row's headline fields. */
export const bestScore = (texts: Array<string | null | undefined>, variants: string[]): number => {
  let best = 0;

  for (const text of texts) {
    for (const variant of variants) {
      best = Math.max(best, textScore(text, variant));
    }
  }

  return best;
};

/**
 * A nudge, never a filter: it moves a row past an equal one, never past a better match.
 */
export const CITY_BIAS = 12;

/**
 * Per type: a request from eight months ago is useless, a guide usually is not. A stale row keeps
 * 40%, so an exact title match still beats a fresh row that merely contains the word.
 */
export const recencyFactor = (
  createdAt: Date | string | null | undefined,
  halfLifeDays: number | null,
): number => {
  if (halfLifeDays === null || !createdAt) return 1;

  const ageMs = Date.now() - new Date(createdAt).getTime();

  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;

  const halfLives = ageMs / (halfLifeDays * 24 * 60 * 60 * 1000);

  return 0.4 + 0.6 * Math.pow(0.5, halfLives);
};
