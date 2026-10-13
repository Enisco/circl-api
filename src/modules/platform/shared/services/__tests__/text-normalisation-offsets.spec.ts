import {
  normaliseForScanning,
  normaliseForScanningWithOffsets,
} from '@/modules/platform/shared/services/text-normalisation';

const CASES = [
  'Plain text about a scam',
  '  Lots   of \n\n whitespace  ',
  'Send me c4sh today',
  'ﬁnd a ﬂat',
  'café vs café',
  'zero​width scam',
  'Tier 4 visa, £500 deposit, working 16 hours',
  'FULLWIDTH ＳＣＡＭ here',
  '',
  '    ',
  'emoji 😀 scam 😀 again',
  'MiXeD CaSe SCAM',
  'a­b scam',
];

/**
 * The offsets are what the reviewer's highlight is drawn from (§5.9), and the one thing that could
 * go wrong silently is the map disagreeing with the normalisation it is a map of. So every case
 * here asserts both: the text matches `normaliseForScanning` exactly, and slicing the original at
 * the mapped offsets gives back the phrase that matched.
 */
describe('normaliseForScanningWithOffsets', () => {
  it.each(CASES)('agrees with the scanner normalisation for %j', value => {
    expect(normaliseForScanningWithOffsets(value).text).toBe(normaliseForScanning(value));
  });

  it.each(CASES)('maps every unit back inside the original for %j', value => {
    const { text, map } = normaliseForScanningWithOffsets(value);

    if (!map) return;

    expect(map).toHaveLength(text.length + 1);

    for (const index of map) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThanOrEqual(value.length);
    }

    // Monotonic: a later match can never highlight earlier text.
    for (let index = 1; index < map.length; index += 1) {
      expect(map[index]).toBeGreaterThanOrEqual(map[index - 1]);
    }
  });

  it('highlights the matched phrase in the original text', () => {
    const value = 'Hello   there, send me c4sh now  ';
    const { text, map } = normaliseForScanningWithOffsets(value);
    const start = text.indexOf('cash');

    expect(start).toBeGreaterThan(-1);
    expect(value.slice(map![start], map![start + 4])).toBe('c4sh');
  });

  it('highlights across collapsed whitespace', () => {
    const value = 'a scam\n\n   is   bad';
    const { text, map } = normaliseForScanningWithOffsets(value);
    const start = text.indexOf('is');

    expect(value.slice(map![start], map![start + 2])).toBe('is');
  });

  it('agrees with the scanner normalisation on random text', () => {
    const alphabet = [
      ...'abc XYZ 014$@ \n\t.,!',
      '\u00ad',
      '\u200b',
      '\u00e9',
      '\u0301',
      '😀',
      'ﬁ',
      'Ｓ',
    ];
    let checked = 0;

    for (let round = 0; round < 500; round += 1) {
      const length = 1 + ((round * 7) % 40);
      let value = '';

      for (let index = 0; index < length; index += 1) {
        value += alphabet[(round * 31 + index * 17) % alphabet.length];
      }

      const { text, map } = normaliseForScanningWithOffsets(value);

      expect(text).toBe(normaliseForScanning(value));

      if (map) {
        expect(map).toHaveLength(text.length + 1);
        checked += 1;
      }
    }

    // The fallback is for inputs nobody has produced here; if it ever becomes the common answer,
    // this is the assertion that says so.
    expect(checked).toBe(500);
  });
});
