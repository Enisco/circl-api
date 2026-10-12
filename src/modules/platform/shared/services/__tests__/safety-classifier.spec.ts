import { RiskCategory } from '@prisma/client';
import { SYSTEM_CONFIG_DEFAULTS } from '@/common';
import { SafetyClassifierService, categoryFor, subcategoryFor } from '../safety-classifier.service';

const SETTINGS = SYSTEM_CONFIG_DEFAULTS['safety.classifier'];

/** A classifier wired to stubs: the provider, the config and the URL signer. */
const build = (
  options: {
    enabled?: boolean;
    scores?: Record<string, number>;
    throws?: Error;
  } = {},
) => {
  const calls: Array<{ parts: unknown; model: string; timeoutMs: number }> = [];
  const openai = {
    moderate: jest.fn(async (parts: unknown, model: string, timeoutMs: number) => {
      calls.push({ parts, model, timeoutMs });

      if (options.throws) throw options.throws;

      return { flagged: false, scores: options.scores ?? {} };
    }),
  };
  const config = {
    get: jest.fn(async () => ({ ...SETTINGS, enabled: options.enabled ?? true })),
  };
  const storage = { readUrl: (key: string) => `https://signed.test/${key}` };

  return {
    classifier: new SafetyClassifierService(openai as never, config as never, storage as never),
    openai,
    calls,
  };
};

describe('the §6.4 category mapping', () => {
  it.each([
    ['self-harm', RiskCategory.SELF_HARM],
    ['self-harm/intent', RiskCategory.SELF_HARM],
    ['self-harm/instructions', RiskCategory.SELF_HARM],
    ['hate', RiskCategory.HATE],
    ['hate/threatening', RiskCategory.HATE],
    ['harassment', RiskCategory.OTHER],
    ['harassment/threatening', RiskCategory.OTHER],
    ['violence', RiskCategory.OTHER],
    ['violence/graphic', RiskCategory.OTHER],
    ['illicit', RiskCategory.RESTRICTED_ITEM],
    ['illicit/violent', RiskCategory.RESTRICTED_ITEM],
    ['sexual', RiskCategory.OTHER],
  ])('%s maps to %s', (category, expected) => {
    expect(categoryFor(category)).toBe(expected);
  });

  /**
   * The one that must not be swallowed by the shorter prefix beside it. `sexual/minors` is
   * EXPLOITATION and always critical; `sexual` is OTHER and usually is not. Matching the wrong one
   * is the difference between a Guard case and a nudity flag.
   */
  it('matches sexual/minors before sexual', () => {
    expect(categoryFor('sexual/minors')).toBe(RiskCategory.EXPLOITATION);
    expect(subcategoryFor('sexual/minors')).toBe('CSAE');
    expect(subcategoryFor('sexual')).toBe('NUDITY_SEXUAL');
  });

  it('keeps the sub-label a reviewer reads, where §6.4 asks for one', () => {
    expect(subcategoryFor('harassment/threatening')).toBe('THREAT');
    expect(subcategoryFor('violence')).toBe('THREAT');
    expect(subcategoryFor('self-harm')).toBeNull();
  });

  it('answers null for a category it has never heard of, rather than guessing', () => {
    expect(categoryFor('something-new')).toBeNull();
  });
});

describe('the classifier score C (§6.3)', () => {
  it('is the maximum of score × multiplier, not the sum', async () => {
    // Three middling categories must not add up to something worse than one certain one.
    const { classifier } = build({
      scores: { harassment: 0.3, violence: 0.3, 'illicit/violent': 0.3 },
    });
    const { result } = await classifier.classify({ fields: { content: 'anything' } });

    expect(result?.score).toBe(33); // 0.3 × 1.1 = 0.33.
  });

  it('applies the per-category multiplier from config', async () => {
    const { classifier } = build({ scores: { 'sexual/minors': 0.6 } });
    const { result } = await classifier.classify({ fields: { content: 'anything' } });

    // 0.6 × 1.5 = 0.9. The multiplier is the judgement: half sure about a child is already past
    // our threshold.
    expect(result?.score).toBe(90);
    expect(result?.category).toBe(RiskCategory.EXPLOITATION);
  });

  it('caps at 100, so a multiplier cannot push a score off the scale', async () => {
    const { classifier } = build({ scores: { 'sexual/minors': 0.99 } });
    const { result } = await classifier.classify({ fields: { content: 'anything' } });

    expect(result?.score).toBe(100);
  });

  it('is confident on a raw score of 0.85, before any multiplier', async () => {
    const { classifier } = build({ scores: { sexual: 0.86 } });
    const { result } = await classifier.classify({ fields: { content: 'anything' } });

    expect(result?.confident).toBe(true);
  });

  it('is not confident on a score that only a multiplier lifted', async () => {
    // 0.6 × 1.5 = 0.9 weighted, but the model itself said 0.6.
    const { classifier } = build({ scores: { 'sexual/minors': 0.6 } });
    const { result } = await classifier.classify({ fields: { content: 'anything' } });

    expect(result?.confident).toBe(false);
  });

  it('keeps the raw scores, which is what a reviewer is shown', async () => {
    const { classifier } = build({ scores: { hate: 0.2, sexual: 0.1 } });
    const { result } = await classifier.classify({ fields: { content: 'anything' } });

    expect(result?.scores).toEqual({ hate: 0.2, sexual: 0.1 });
  });
});

describe('what it sends', () => {
  it('sends the fields as one text part and the model and timeout from config', async () => {
    const { classifier, calls } = build({ scores: {} });

    await classifier.classify({ fields: { title: 'a title', body: 'a body' } });

    expect(calls[0].model).toBe(SETTINGS.model);
    expect(calls[0].timeoutMs).toBe(SETTINGS.timeoutMs);
    expect(calls[0].parts).toEqual([{ type: 'text', text: 'a title\n\na body' }]);
  });

  it('signs media into URLs, because the model has to fetch them', async () => {
    const { classifier, calls } = build({ scores: {} });

    await classifier.classify({ fields: {}, mediaKeys: ['photos/one.jpg'] });

    expect(calls[0].parts).toEqual([
      { type: 'image_url', image_url: { url: 'https://signed.test/photos/one.jpg' } },
    ]);
  });

  it('skips empty fields rather than sending blank lines', async () => {
    const { classifier, calls } = build({ scores: {} });

    await classifier.classify({ fields: { title: 'kept', description: null, note: '   ' } });

    expect(calls[0].parts).toEqual([{ type: 'text', text: 'kept' }]);
  });
});

describe('every way of not having an answer (§6.7)', () => {
  it('does not call out at all when the classifier is off', async () => {
    const { classifier, openai } = build({ enabled: false });
    const { result, error } = await classifier.classify({ fields: { content: 'anything' } });

    expect(result).toBeNull();
    expect(error).toBeNull();
    expect(openai.moderate).not.toHaveBeenCalled();
  });

  it('turns a timeout into "no answer" and keeps the reason, rather than throwing', async () => {
    const { classifier } = build({ throws: new Error('The operation was aborted') });
    const { result, error } = await classifier.classify({ fields: { content: 'anything' } });

    // The member's post must not fail because OpenAI is slow. §6.7 decides what happens next, and
    // it needs the reason to put on the scan row.
    expect(result).toBeNull();
    expect(error).toContain('aborted');
  });

  it('says so when there is nothing to scan', async () => {
    const { classifier, openai } = build({ scores: {} });
    const { result, error } = await classifier.classify({ fields: { title: null } });

    expect(result).toBeNull();
    expect(error).toBe('nothing to scan');
    expect(openai.moderate).not.toHaveBeenCalled();
  });
});
