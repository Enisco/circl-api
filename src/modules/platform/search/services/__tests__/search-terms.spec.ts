import {
  bestScore,
  normaliseTerm,
  recencyFactor,
  stemOf,
  termVariants,
  termWords,
  textScore,
} from '../search-terms';

describe('normaliseTerm', () => {
  it('collapses the whitespace a paste brings with it', () => {
    expect(normaliseTerm('  visa   application \n')).toBe('visa application');
  });

  it('treats a missing term as an empty one rather than throwing', () => {
    expect(normaliseTerm(undefined)).toBe('');
    expect(normaliseTerm(null)).toBe('');
  });

  it('truncates a paste, which is not a search', () => {
    expect(normaliseTerm('a'.repeat(500))).toHaveLength(64);
  });
});

describe('stemOf', () => {
  it.each([
    ['bursaries', 'bursary'],
    ['renting', 'rent'],
    ['applied', 'appli'],
    ['buses', 'bus'],
    ['visas', 'visa'],
  ])('%s stems to %s', (word, expected) => {
    expect(stemOf(word)).toBe(expected);
  });

  it.each(['gp', 'nhs', 'bus', 'les', 'class'])('leaves %s alone', word => {
    // Short words and double-s endings are where a crude stemmer does damage, not good.
    expect(stemOf(word)).toBeNull();
  });
});

describe('termVariants', () => {
  it('asks for the stem as well as the word', () => {
    expect(termVariants('visas')).toEqual(['visas', 'visa']);
  });

  it('leaves a phrase alone, because stemming its last word asks for something nobody wrote', () => {
    expect(termVariants('visa applications')).toEqual(['visa applications']);
  });

  it('does not repeat a word that stems to itself', () => {
    expect(termVariants('visa')).toEqual(['visa']);
  });
});

describe('termWords', () => {
  it('drops the one-character words that would match everything', () => {
    expect(termWords('ama o okonkwo')).toEqual(['ama', 'okonkwo']);
  });
});

describe('textScore', () => {
  it('ranks an exact title above a prefix, a prefix above a word, a word above an infix', () => {
    const exact = textScore('Visa', 'visa');
    const prefix = textScore('Visa renewal in Leeds', 'visa');
    const word = textScore('Renewing a visa in Leeds', 'visa');
    const infix = textScore('Multivisa advice', 'visa');

    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(infix);
    expect(infix).toBeGreaterThan(0);
  });

  it('scores a row that matched somewhere this scorer cannot see at zero, not negative', () => {
    expect(textScore('Something else entirely', 'visa')).toBe(0);
    expect(textScore(null, 'visa')).toBe(0);
  });
});

describe('bestScore', () => {
  it('takes the best field and the best variant, not the first', () => {
    expect(bestScore([null, 'Bursary', 'unrelated'], ['bursaries', 'bursary'])).toBe(
      textScore('Bursary', 'bursary'),
    );
  });
});

describe('recencyFactor', () => {
  const days = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

  it('leaves a type with no half-life untouched, however old the row', () => {
    expect(recencyFactor(days(400), null)).toBe(1);
  });

  it('decays towards a floor rather than to nothing', () => {
    const fresh = recencyFactor(days(0), 45);
    const stale = recencyFactor(days(240), 45);

    expect(fresh).toBeCloseTo(1, 2);
    expect(stale).toBeGreaterThan(0.4);
    expect(stale).toBeLessThan(0.45);
  });

  it('halves the decaying part at exactly one half-life', () => {
    expect(recencyFactor(days(45), 45)).toBeCloseTo(0.7, 2);
  });

  it('never penalises a row with no date at all', () => {
    expect(recencyFactor(null, 45)).toBe(1);
  });
});
