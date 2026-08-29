import { excerpt, keywordCoverage, keywords, readTimeMinutes, toPlainText } from '../text.util';

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
