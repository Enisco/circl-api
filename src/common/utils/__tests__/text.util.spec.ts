import {
  escapeLike,
  excerpt,
  keywordCoverage,
  keywords,
  readTimeMinutes,
  stripFormatting,
  toPlainText,
} from '../text.util';

describe('text utilities', () => {
  describe('keywords', () => {
    it('stems so a question and the guide that answers it share words', () => {
      expect(keywords('How do I open a bank account?')).toContain('open');
      expect(keywords('Opening a UK bank account')).toContain('open');
    });

    it('does not mangle words that merely end in double s', () => {
      expect(keywords('proof of address')).toContain('address');
      expect(keywords('starting a business')).toContain('business');
    });

    it('undoubles the consonant English adds before -ing', () => {
      expect(keywords('running a shop')).toContain('run');
    });

    it('drops stopwords and short tokens', () => {
      expect(keywords('I need help with the visa')).toEqual(['visa']);
    });
  });

  describe('keywordCoverage', () => {
    // The bug this replaced: Jaccard scored a thorough guide DOWN for being thorough, so the "Before you post" interstitial never fired.
    it('does not punish a candidate for being longer than the question', () => {
      const question = keywords('open a bank account without proof of address');
      const guide = keywords(
        'Opening a UK bank account with no proof of address. Book an appointment, take your BRP, ' +
          'a university or employer letter, and your passport, and ask for a basic account.',
      );

      expect(keywordCoverage(question, guide)).toBeGreaterThan(0.8);
    });

    it('scores an unrelated candidate at zero', () => {
      expect(
        keywordCoverage(keywords('understanding my CoS letter'), keywords('bank account')),
      ).toBe(0);
    });
  });

  describe('readTimeMinutes', () => {
    it('rounds up and never returns zero', () => {
      expect(readTimeMinutes('one two three')).toBe(1);
      expect(readTimeMinutes(Array(400).fill('word').join(' '))).toBe(2);
    });

    it('does not count the markers as words', () => {
      // A bulleted list would otherwise read as twice its length, because every `-` is a word.
      expect(readTimeMinutes(Array(300).fill('- word').join('\n'))).toBe(
        readTimeMinutes(Array(300).fill('word').join('\n')),
      );
      expect(readTimeMinutes('*one* _two_ ~three~')).toBe(readTimeMinutes('one two three'));
    });
  });

  describe('stripFormatting', () => {
    it('removes a marker that pairs on its own line', () => {
      expect(stripFormatting('*bold* and _italic_ and ~gone~ and `mono`')).toBe(
        'bold and italic and gone and mono',
      );
      expect(stripFormatting('Ada: bring *ID*')).toBe('Ada: bring ID');
      expect(stripFormatting('*a* *b*')).toBe('a b');
    });

    it('leaves a marker that finds no pair as the character it is', () => {
      expect(stripFormatting('2 * 3 * 4')).toBe('2 * 3 * 4');
      expect(stripFormatting('my_file_name.txt')).toBe('my_file_name.txt');
      expect(stripFormatting('unpaired * star')).toBe('unpaired * star');
    });

    it('drops a bullet, a number or a quote, and keeps the lines', () => {
      expect(stripFormatting('- bring ID\n- proof of address')).toBe('bring ID\nproof of address');
      expect(stripFormatting('1. first\n2. second')).toBe('first\nsecond');
      expect(stripFormatting('> a quote')).toBe('a quote');
      expect(stripFormatting('* a bullet starting with a star')).toBe(
        'a bullet starting with a star',
      );
    });

    it('never spans a line, so one stray character cannot reformat a page', () => {
      expect(stripFormatting('an opening *marker\nand a closing* one')).toBe(
        'an opening *marker\nand a closing* one',
      );
    });
  });

  describe('excerpt', () => {
    it('cuts on a word boundary and marks the truncation', () => {
      const result = excerpt('word '.repeat(80), 50);

      expect(result.length).toBeLessThanOrEqual(51);
      expect(result.endsWith('…')).toBe(true);
      expect(result).not.toMatch(/wor…$/);
    });

    it('returns short text unchanged', () => {
      expect(excerpt('short enough', 200)).toBe('short enough');
    });
  });

  describe('toPlainText', () => {
    it('strips markup, because the client renders text and will not interpret it', () => {
      expect(toPlainText('<b>hello</b> <script>alert(1)</script>there')).toBe(
        'hello alert(1)there',
      );
    });
  });
});

describe('escapeLike', () => {
  // Every `q=` filter ends up inside an ILIKE, where `%` and `_` are wildcards: `%%` would match
  // every row of every type at once, without the trigram index.
  it('escapes the two ILIKE wildcards and the escape character itself', () => {
    expect(escapeLike('100%')).toBe('100\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
    expect(escapeLike('back\\slash')).toBe('back\\\\slash');
  });

  it('leaves ordinary text, including punctuation, alone', () => {
    expect(escapeLike("o'brien & co.")).toBe("o'brien & co.");
    expect(escapeLike('visa')).toBe('visa');
    expect(escapeLike('')).toBe('');
  });
});
