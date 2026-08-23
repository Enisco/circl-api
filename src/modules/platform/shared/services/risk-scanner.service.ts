import { Injectable } from '@nestjs/common';
import { RiskCategory, RiskLevel } from '@prisma/client';
import { PrismaService } from '@/infrastructure';

export interface RiskAssessment {
  level: RiskLevel;
  category: RiskCategory | null;
  score: number;
  /** The matched phrases, so a reviewer can see why this reached their queue. */
  signals: Array<{ category: RiskCategory; pattern: string; weight: number }>;
}

/**
 * Circl Guard's risk scanner.
 *
 * "An algorithm scans posts and private admin messages for high-risk language
 * (suicidal ideation, domestic violence, deportation risk, scams, landlord
 * fraud). Sensitive requests are ranked by urgency and pushed to the top of the
 * admin queue with an alert."
 *
 * Three properties this deliberately has, and one it deliberately does not:
 *
 *   Auditable — every escalation names the phrases that caused it, so "why was my
 *   post flagged" has an answer. A model's embedding does not.
 *   Fast — an in-process phrase match over a cached lexicon, no network hop, so
 *   it runs inline on every create without a member waiting.
 *   Editable — the lexicon is a table, so safeguarding staff add a phrase the
 *   moment they see it used rather than waiting for a release.
 *
 * What it does NOT do is block anything. It decides where a post lands in the
 * admin queue and nothing else. A false positive costs a reviewer thirty seconds;
 * a false negative costs considerably more, so the thresholds lean toward
 * escalating.
 */
@Injectable()
export class RiskScannerService {
  private lexicon: Array<{
    category: RiskCategory;
    pattern: string;
    weight: number;
    regex: RegExp;
  }> = [];
  private loadedAt = 0;

  private static readonly TTL_MS = 120_000;

  // Additive score thresholds. One unambiguous phrase ("held against my will",
  // weight 65) reaches HIGH alone; softer phrases have to co-occur.
  private static readonly THRESHOLDS: Array<[number, RiskLevel]> = [
    [90, RiskLevel.CRITICAL],
    [55, RiskLevel.HIGH],
    [30, RiskLevel.MEDIUM],
    [1, RiskLevel.LOW],
  ];

  constructor(private readonly database: PrismaService) {}

  private async ensureLoaded(): Promise<void> {
    if (this.lexicon.length && Date.now() - this.loadedAt < RiskScannerService.TTL_MS) return;

    const terms = await this.database.riskTerm.findMany({ where: { isActive: true } });

    this.lexicon = terms.map(term => ({
      category: term.category,
      pattern: term.pattern,
      weight: term.weight,
      // Word boundaries, so "scam" does not fire on "scamper" and an apostrophe
      // inside a phrase still matches.
      regex: new RegExp(`(?<![\\w])${escapeRegExp(term.pattern)}(?![\\w])`, 'i'),
    }));
    this.loadedAt = Date.now();
  }

  async scan(...texts: Array<string | null | undefined>): Promise<RiskAssessment> {
    await this.ensureLoaded();

    const haystack = texts.filter(Boolean).join(' \n ').toLowerCase();

    if (!haystack.trim()) {
      return { level: RiskLevel.NONE, category: null, score: 0, signals: [] };
    }

    const signals: RiskAssessment['signals'] = [];
    const perCategory = new Map<RiskCategory, number>();
    let score = 0;

    for (const term of this.lexicon) {
      if (!term.regex.test(haystack)) continue;

      signals.push({ category: term.category, pattern: term.pattern, weight: term.weight });
      score += term.weight;
      perCategory.set(term.category, (perCategory.get(term.category) ?? 0) + term.weight);
    }

    if (!signals.length) {
      return { level: RiskLevel.NONE, category: null, score: 0, signals: [] };
    }

    // The category is the heaviest one matched, not the first — a post mentioning
    // both a scam and self-harm is a self-harm case.
    const category = [...perCategory.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const level =
      RiskScannerService.THRESHOLDS.find(([minimum]) => score >= minimum)?.[1] ?? RiskLevel.NONE;

    return { level, category, score, signals };
  }

  /** Whether an assessment is severe enough to jump the moderation queue. */
  isUrgent(assessment: RiskAssessment): boolean {
    return assessment.level === RiskLevel.HIGH || assessment.level === RiskLevel.CRITICAL;
  }
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
