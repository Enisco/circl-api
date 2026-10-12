import { Injectable, Logger } from '@nestjs/common';
import { RiskCategory } from '@prisma/client';
import { SYSTEM_CONFIG_KEYS } from '@/common';
import { OpenAIProvider } from '@/modules/infrastructure/ai/openai.provider';
import { ClassifierResult } from './safety-scoring';
import { SystemConfigService } from './system-config.service';
import { StorageProvider } from '../../media/storage';

/**
 * A single category score confident enough to stand on its own (§6.3 rule 1).
 *
 * At 0.85 the model is not guessing. The rule it unlocks — "a confident classifier is never
 * diluted by a silent lexicon" — exists because the blend would otherwise let a 0.93 on self-harm
 * out at 56, which is a held post becoming a published one on arithmetic nobody intended.
 */
const CONFIDENT_AT = 0.85;

/**
 * omni-moderation's categories, mapped onto ours (§6.4).
 *
 * Longest prefix wins, so `self-harm/intent` is matched before `self-harm` and
 * `harassment/threatening` before `harassment`. The order of the table is therefore not
 * decorative — it is the matching rule.
 */
const CATEGORY_MAP: Array<[prefix: string, category: RiskCategory, subcategory?: string]> = [
  // Always critical, always a Guard case. §6.4.1 is explicit that the system never reports this
  // anywhere itself: a detection is a signal, and the external report is a decision a person
  // makes offline.
  ['sexual/minors', RiskCategory.EXPLOITATION, 'CSAE'],
  ['self-harm', RiskCategory.SELF_HARM],
  ['hate/threatening', RiskCategory.HATE, 'THREAT'],
  ['hate', RiskCategory.HATE],
  ['harassment/threatening', RiskCategory.OTHER, 'THREAT'],
  ['harassment', RiskCategory.OTHER, 'HARASSMENT'],
  ['violence', RiskCategory.OTHER, 'THREAT'],
  ['illicit', RiskCategory.RESTRICTED_ITEM],
  ['sexual', RiskCategory.OTHER, 'NUDITY_SEXUAL'],
];

export interface ClassifierInput {
  /** The same fields the lexicon scanned, so the two opinions are about the same words. */
  fields: Record<string, string | null | undefined>;
  /** Storage keys of attached images; signed into URLs here because the model fetches them. */
  mediaKeys?: string[];
}

/**
 * The classifier half of the pipeline (§6.2 steps 5–6, §6.3's `C`).
 *
 * Returns `null` for every way of not having an answer — disabled, timed out, refused, empty —
 * because `scoreOf` takes `null` to mean "degraded" and that is the only distinction the scoring
 * rules need. The *reason* is logged and recorded on the scan row, where it is a dashboard figure
 * rather than a branch.
 */
@Injectable()
export class SafetyClassifierService {
  private readonly logger = new Logger(SafetyClassifierService.name);

  constructor(
    private readonly openai: OpenAIProvider,
    private readonly config: SystemConfigService,
    private readonly storage: StorageProvider,
  ) {}

  async enabled(): Promise<boolean> {
    return (await this.config.get(SYSTEM_CONFIG_KEYS.CLASSIFIER)).enabled;
  }

  /**
   * One pass over the content.
   *
   * Text and images in one call, which is what omni-moderation takes. Images are signed read URLs
   * — the model has to fetch them, and the bucket is not public.
   */
  async classify(
    input: ClassifierInput,
  ): Promise<{ result: ClassifierResult | null; model: string; error: string | null }> {
    const settings = await this.config.get(SYSTEM_CONFIG_KEYS.CLASSIFIER);

    if (!settings.enabled) return { result: null, model: settings.model, error: null };

    const text = Object.values(input.fields)
      .filter((value): value is string => !!value && value.trim().length > 0)
      .join('\n\n');
    const parts: Array<
      { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
    > = [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...(input.mediaKeys ?? []).map(key => ({
        type: 'image_url' as const,
        image_url: { url: this.storage.readUrl(key) },
      })),
    ];

    if (!parts.length) return { result: null, model: settings.model, error: 'nothing to scan' };

    try {
      const response = await this.openai.moderate(parts, settings.model, settings.timeoutMs);

      return {
        result: this.scoreOf(response, settings.multipliers),
        model: settings.model,
        error: null,
      };
    } catch (error) {
      const message = (error as Error).message || 'unknown';

      // Loud, and then handed back as "no answer". §6.7 decides what happens next; the worker does
      // not get to choose, and the member's post does not fail because OpenAI is slow.
      this.logger.warn(`Classifier unavailable (${message})`);

      return { result: null, model: settings.model, error: message.slice(0, 500) };
    }
  }

  /**
   * `C = round(100 × max_k(s_k × m_k))`, and the category behind it (§6.3, §6.4).
   *
   * The maximum rather than a sum: these are independent probabilities of different things, and
   * adding them would make a post that is slightly several things look worse than one that is
   * definitely one thing.
   */
  private scoreOf(
    response: { flagged: boolean; scores: Record<string, number> },
    multipliers: Record<string, number>,
  ): ClassifierResult {
    let score = 0;
    let top: string | null = null;
    let confident = false;

    for (const [category, raw] of Object.entries(response.scores)) {
      const weighted = raw * (multipliers[category] ?? 1);

      if (weighted > score) {
        score = weighted;
        top = category;
      }

      if (raw >= CONFIDENT_AT) confident = true;
    }

    return {
      scores: response.scores,
      score: Math.max(0, Math.min(100, Math.round(100 * score))),
      confident,
      category: top ? categoryFor(top) : null,
    };
  }
}

/** The §6.4 mapping, longest prefix first. Exported for the tests that hold the table to it. */
export const categoryFor = (moderationCategory: string): RiskCategory | null => {
  const match = CATEGORY_MAP.find(([prefix]) => moderationCategory.startsWith(prefix));

  return match ? match[1] : null;
};

/** The sub-label a reviewer reads, where §6.4 asks for one ("THREAT", "NUDITY_SEXUAL", "CSAE"). */
export const subcategoryFor = (moderationCategory: string): string | null => {
  const match = CATEGORY_MAP.find(([prefix]) => moderationCategory.startsWith(prefix));

  return match?.[2] ?? null;
};
