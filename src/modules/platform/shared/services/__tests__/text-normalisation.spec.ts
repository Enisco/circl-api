import { normaliseForScanning } from '../text-normalisation';

const ZERO_WIDTH = String.fromCharCode(0x200b);
const SOFT_HYPHEN = String.fromCharCode(0x00ad);
const RTL_OVERRIDE = String.fromCharCode(0x202e);

/**
 * The lexicon matches a stored phrase against member text, so both sides go through this. Until it
 * existed the scanner only lowercased what it scanned, which meant every evasion below worked —
 * and a staff-entered phrase holding any of these characters could never fire, with nothing to
 * distinguish that from the phrase simply never coming up.
 */
describe('normaliseForScanning', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normaliseForScanning('  Send   ME  the CASH \n now ')).toBe('send me the cash now');
  });

  it('folds the leetspeak people actually use', () => {
    for (const evasion of ['c4sh', 'ca$h', 'c45h']) {
      expect(normaliseForScanning(evasion)).toBe('cash');
    }
  });

  it('strips characters that render as nothing', () => {
    expect(normaliseForScanning(`ca${ZERO_WIDTH}sh`)).toBe('cash');
    expect(normaliseForScanning(`ca${SOFT_HYPHEN}sh`)).toBe('cash');
    expect(normaliseForScanning(`ca${RTL_OVERRIDE}sh`)).toBe('cash');
  });

  it('normalises compatibility forms, so a full-width spelling is the ordinary one', () => {
    expect(normaliseForScanning('ｃａｓｈ')).toBe('cash');
  });

  it('is idempotent, which is what lets a pattern be stored in this form', () => {
    const once = normaliseForScanning(` C4$H${ZERO_WIDTH}  now `);

    expect(normaliseForScanning(once)).toBe(once);
    expect(once).toBe('cash now');
  });

  it('leaves ordinary text alone apart from case', () => {
    // The point of keeping the leetspeak map narrow: a wider one starts rewriting real words.
    expect(normaliseForScanning('Nursery waiting lists in Leeds')).toBe(
      'nursery waiting lists in leeds',
    );
  });

  describe('numbers, which this domain is made of', () => {
    // Folding every digit turned "working 16 hours" into "working i6 hours" and "£500 deposit"
    // into "£soo deposit". Both sides normalise, so matching still worked — what broke was
    // everything a person reads: a staff member typing a phrase with a number in it got back
    // something that looked corrupted. One of the seeded risk terms was affected.
    it.each([
      ['working 16 hours', 'working 16 hours'],
      ['tier 4 visa', 'tier 4 visa'],
      ['£500 deposit', '£500 deposit'],
      ['24 hours', '24 hours'],
      ['pay 50 now', 'pay 50 now'],
      // Leetspeak for a word, and also a quantity. Of the two readings, the number is the one that
      // turns up in real messages.
      ['1337', '1337'],
    ])('leaves %s alone', (input, expected) => {
      expect(normaliseForScanning(input)).toBe(expected);
    });

    it('still folds a substitution inside a word in the same sentence as a number', () => {
      expect(normaliseForScanning('c4sh in 48 hours')).toBe('cash in 48 hours');
    });

    it('folds a leading substitution, which is a real evasion', () => {
      expect(normaliseForScanning('5hady')).toBe('shady');
      expect(normaliseForScanning('@dvance fee')).toBe('advance fee');
    });

    it('does not let one substitution make the next look intra-word', () => {
      // Judged on the original string. Rewriting left to right, the `o` from `0` would make the
      // following `0` look as though it had a letter beside it.
      expect(normaliseForScanning('500')).toBe('500');
    });
  });

  it('can collapse a long input to nothing, which is why length is checked afterwards', () => {
    expect(normaliseForScanning(ZERO_WIDTH.repeat(40))).toBe('');
  });
});
