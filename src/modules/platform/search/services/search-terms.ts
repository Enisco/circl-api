/**
 * Query shaping and in-group ranking, kept out of the service so both can be unit tested without
 * a database.
 *
 * Two ideas do the work. A term is *expanded* before it reaches SQL, so "visas" also asks for
 * "visa" and the member does not have to guess our grammar. Results are then *ranked in memory*
 * over a small overfetched window, because eight types with eight different shapes cannot share
 * one ORDER BY, and sorting twenty rows in process costs microseconds against the milliseconds a
 * second round trip would cost.
 */

/** Longer than this is a paste, not a search, and trigram matching degrades badly on it. */
const MAX_TERM_LENGTH = 64;

/** Below this a term matches most of the corpus, so it is not worth eight queries. */
export const MIN_TERM_LENGTH = 2;

export const normaliseTerm = (raw: string | undefined | null): string =>
  (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TERM_LENGTH);

/**
 * One crude English stem, not a stemmer. It exists so a member typing the plural of the word a
 * poster typed in the singular still finds the post, which is the single most common near miss.
 * It deliberately does nothing to short words, where the ending is usually part of the word.
 */
export const stemOf = (word: string): string | null => {
  const lower = word.toLowerCase();

  if (lower.endsWith('ies') && lower.length > 4) return `${lower.slice(0, -3)}y`;
  if (lower.endsWith('ing') && lower.length > 5) return lower.slice(0, -3);
  if (lower.endsWith('ed') && lower.length > 4) return lower.slice(0, -2);
  if (lower.endsWith('es') && lower.length > 4) return lower.slice(0, -2);
  if (lower.endsWith('s') && !lower.endsWith('ss') && lower.length > 3) return lower.slice(0, -1);

  return null;
};

/**
 * The forms a single-word term is asked for in SQL. A phrase is left alone: stemming only the
 * last word of "visa applications" would ask for something nobody wrote.
 */
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
 * A city match is a nudge, never a filter (the spec is explicit: someone searching "visa" in
 * London should see the London request first, not only London requests). Twelve points moves a
 * row past an equal one and never past a better textual match, which is the whole intent.
 */
export const CITY_BIAS = 12;

/**
 * Recency decay, applied per type rather than globally: a request from eight months ago is almost
 * never useful, a guide from eight months ago usually is. A fully stale row keeps 40% of its
 * score, so an exact title match still beats a fresh row that merely contains the word.
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
