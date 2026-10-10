/**
 * One normalisation, used on both sides of every lexicon match (spec §6.2 step 1).
 *
 * The scanner compares a stored phrase against member text. If the two are normalised differently
 * — or one of them is not normalised at all — the comparison is between two things that were never
 * made comparable, and it fails quietly: the phrase sits in the lexicon looking active, its hit
 * count stays at zero, and nothing distinguishes "this never came up" from "this cannot match".
 *
 * Which is the state the scanner was in. It lowercased the text it scanned and nothing else, and
 * stored patterns lowercased too — so none of the evasions below were caught, and a staff member
 * who pasted a phrase containing a zero-width character had added a term that could never fire.
 *
 * Applied to member text when scanning, and to a pattern when it is written. Deliberately one
 * exported function rather than a method on the scanner: a second copy would drift, and the whole
 * point is that both sides agree.
 */

/**
 * The invisible characters, by codepoint: soft hyphen, the zero-width spaces and joiners, the
 * line and paragraph separators, the bidirectional overrides, the word joiner and the byte-order
 * mark. All of them render as nothing and are therefore free to somebody evading a word filter —
 * a zero-width space inside a word reads as the word to a person and matched nothing at all here.
 *
 * Listed as numbers rather than written into a regex literal on purpose. A character class full of
 * zero-width escapes is a line that cannot survive being copied through a shell, an editor or a
 * patch without some layer helpfully turning the escape into the character it denotes — at which
 * point the source contains the very invisible characters it exists to remove, and the file stops
 * parsing. Built from codepoints, there is nothing to misinterpret.
 */
const INVISIBLE_RANGES: Array<[number, number]> = [
  [0x00ad, 0x00ad],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0xfeff, 0xfeff],
];

const INVISIBLE = new RegExp(
  `[${INVISIBLE_RANGES.map(([from, to]) =>
    from === to
      ? `\\u${from.toString(16).padStart(4, '0')}`
      : `\\u${from.toString(16).padStart(4, '0')}-\\u${to.toString(16).padStart(4, '0')}`,
  ).join('')}]`,
  'g',
);

/**
 * The substitutions people actually make. Narrow on purpose.
 *
 * Every entry is a letter somebody types as a digit or a symbol to get past a word filter —
 * "c4sh", "$cam", "k1ll". The temptation is to add more: `rn` for `m`, every lookalike in Unicode.
 * That way lies a filter that reads "a1l" as "ail" and flags somebody discussing a pharmacy.
 */
const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  $: 's',
  '@': 'a',
};

/** ASCII letters only: the test is "is this digit inside a word", not "is it next to anything". */
const isLetter = (character: string | undefined): boolean =>
  character !== undefined && character >= 'a' && character <= 'z';

/**
 * Folds a leetspeak character **only when it sits inside a word**, which is the difference between
 * catching an evasion and corrupting a number.
 *
 * Applied everywhere, `5` became `s` and `0` became `o` — so "working 16 hours" was stored as
 * "working i6 hours", "tier 4 visa" as "tier a visa", and "£500 deposit" as "£soo deposit". Both
 * sides go through this, so matching still worked; what broke was everything a person has to read.
 * A staff member typing a phrase with a number in it got back something that looked corrupted, and
 * this domain is made of numbers — money, hours, visa tiers, deadlines.
 *
 * A digit with a letter beside it is somebody spelling a word with it. A digit with a space or
 * another digit beside it is a number, and is left alone. "1337" therefore stays "1337": it is
 * leetspeak for a word, and it is also a quantity, and of the two readings the number is the one
 * that appears in real messages.
 *
 * Adjacency is judged on the string as it was, not as it is being rewritten, so one substitution
 * cannot make the next one look intra-word when it was not.
 */
const foldLeet = (lowered: string): string => {
  let out = '';

  for (let index = 0; index < lowered.length; index += 1) {
    const character = lowered[index];
    const replacement = LEET[character];

    out +=
      replacement && (isLetter(lowered[index - 1]) || isLetter(lowered[index + 1]))
        ? replacement
        : character;
  }

  return out;
};

/**
 * Member text, ready to be matched against the lexicon.
 *
 * NFKC first, so a full-width or decomposed form becomes the ordinary one; then the invisible
 * characters go; then case; then leetspeak; then whitespace collapses to single spaces.
 */
export const normaliseForScanning = (value: string): string =>
  foldLeet(value.normalize('NFKC').replace(INVISIBLE, '').toLowerCase())
    .replace(/\s+/g, ' ')
    .trim();

/**
 * A lexicon pattern, stored in the form the scanner will compare against.
 *
 * The same function, named separately because the two uses are not the same decision: one is
 * applied to text in flight, the other is applied once and **persisted**, which is why a pattern's
 * length is validated after this runs rather than before. A phrase that normalises to one
 * character is not a phrase, however long it looked when it was typed.
 */
export const normalisePattern = normaliseForScanning;
