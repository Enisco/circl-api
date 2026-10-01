/** Text helpers shared by every composer. */

/** Strips tags and collapses whitespace. Nothing calls it: write paths trim, they do not reshape. */
export const toPlainText = (input: string): string =>
  input
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** A truncated description for feed and list cards, so the payload does not carry full bodies (1.1). */
export const excerpt = (input: string | null | undefined, max = 200): string => {
  if (!input) return '';

  const text = input.replace(/\s+/g, ' ').trim();

  if (text.length <= max) return text;

  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');

  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
};

/**
 * The chat formatting markers, which members type into guides and messages and clients render.
 * Each is removed only where it pairs with another on the same line, which is what makes
 * `2 * 3 * 4` arithmetic and leaves `my_file_name.txt` its underscores: an opening marker has to
 * follow a non-word character and be followed by a non-space, and a closing one has to be preceded
 * by a non-space and not be followed by a word character. Nothing spans a line.
 */
const INLINE_MARKERS = ['\\*', '_', '~', '`'];

/** A bullet, a numbered item or a quote, which are line-level and carry a space after the marker. */
const LINE_MARKER = /^[ \t]*(?:[-*][ \t]+|\d+\.[ \t]+|>[ \t]?)/;

/**
 * The text without its formatting markers, for anywhere the server reads member text for something
 * other than storing it: a read time, a push preview, a line quoted back. Rendering stays the
 * client's job, and the stored string is never touched — markers have to arrive back as they were
 * sent, newlines included, or a list stops being a list.
 */
export const stripFormatting = (input: string): string =>
  input
    .split('\n')
    .map(line => {
      let text = line.replace(LINE_MARKER, '');

      for (const marker of INLINE_MARKERS) {
        text = text.replace(
          new RegExp(`(^|[^\\w])${marker}(\\S|\\S[^${marker}\\n]*\\S)${marker}(?![\\w])`, 'g'),
          '$1$2',
        );
      }

      return text;
    })
    .join('\n');

/**
 * Read time, computed server-side at write time so every client agrees (1.6.1). Markers come out
 * first: `*` is not a word, and a bulleted list would otherwise read as twice its length.
 */
export const readTimeMinutes = (text: string): number => {
  const words = stripFormatting(text).trim().split(/\s+/).filter(Boolean).length;

  return Math.max(1, Math.ceil(words / 200));
};

/** The normalised form used for question clustering (Auto-Guides) and for the guide match in 1.6.5. */
const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'if',
  'of',
  'to',
  'in',
  'on',
  'at',
  'for',
  'with',
  'about',
  'into',
  'from',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'do',
  'does',
  'did',
  'doing',
  'have',
  'has',
  'had',
  'having',
  'i',
  'me',
  'my',
  'we',
  'our',
  'you',
  'your',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'there',
  'here',
  'can',
  'could',
  'should',
  'would',
  'will',
  'shall',
  'may',
  'might',
  'must',
  'need',
  'needs',
  'needed',
  'how',
  'what',
  'when',
  'where',
  'which',
  'who',
  'whom',
  'why',
  'any',
  'some',
  'anyone',
  'someone',
  'help',
  'please',
  'thanks',
  'thank',
  'hi',
  'hello',
  'uk',
]);

/** A crude suffix stripper, so "open" and "opening" are the same word. */
const stem = (word: string): string => {
  if (word.length <= 4) return word;

  // "address" and "business" are not plurals.
  if (word.endsWith('ss')) return word;

  for (const suffix of ['ing', 'ies', 'ed', 'es', 's']) {
    if (!word.endsWith(suffix) || word.length - suffix.length < 3) continue;

    const base = word.slice(0, -suffix.length);

    if (suffix === 'ies') return `${base}y`;

    // "running" → "run", not "runn": English doubles the consonant before -ing.
    if (suffix === 'ing' && base.length > 3 && base[base.length - 1] === base[base.length - 2]) {
      return base.slice(0, -1);
    }

    return base;
  }

  return word;
};

export const keywords = (text: string): string[] =>
  Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 2 && !STOPWORDS.has(word))
        .map(stem),
    ),
  );

export const questionSignature = (text: string): string => keywords(text).sort().join(' ');

/** Jaccard overlap of two keyword sets, 0..1. Symmetric: use it to compare two things of similar length, such as two members' questions. */
export const keywordSimilarity = (a: string[], b: string[]): number => {
  if (!a.length || !b.length) return 0;

  const setB = new Set(b);
  const intersection = a.filter(word => setB.has(word)).length;

  return intersection / (a.length + b.length - intersection);
};

/** How much of `needle` appears in `haystack`, 0..1. */
export const keywordCoverage = (needle: string[], haystack: string[]): number => {
  if (!needle.length) return 0;

  const set = new Set(haystack);

  return needle.filter(word => set.has(word)).length / needle.length;
};

/** The raw count of shared keywords, used as a floor against generic overlaps. */
export const keywordOverlapCount = (a: string[], b: string[]): number => {
  const setB = new Set(b);

  return a.filter(word => setB.has(word)).length;
};

/** Escapes the characters Postgres ILIKE treats specially, for a `q` filter. */
export const escapeLike = (input: string): string => input.replace(/[%_\\]/g, char => `\\${char}`);
