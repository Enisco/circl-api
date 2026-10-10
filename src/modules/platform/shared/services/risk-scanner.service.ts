import { Injectable } from '@nestjs/common';
import { RiskCategory, RiskLevel } from '@prisma/client';
import { CacheService, PrismaService } from '@/infrastructure';
import { normaliseForScanning } from './text-normalisation';

export interface RiskAssessment {
  level: RiskLevel;
  category: RiskCategory | null;
  score: number;
  /** The matched phrases, so a reviewer can see why this reached their queue. */
  signals: Array<{ category: RiskCategory; pattern: string; weight: number }>;
}

/** Circl Guard's risk scanner. */
@Injectable()
export class RiskScannerService {
  private lexicon: Array<{
    category: RiskCategory;
    pattern: string;
    weight: number;
    regex: RegExp;
  }> = [];
  private loadedAt = 0;
  /** The lexicon version this instance's copy was built from. */
  private loadedVersion: string | null = null;
  private versionCheckedAt = 0;

  private static readonly TTL_MS = 120_000;
  /**
   * How often an instance asks whether the lexicon has changed.
   *
   * The spec wants a reload "now" rather than after the two-minute cache expires, and suggests
   * publishing on a Redis channel. Subscribing needs its own connection — ioredis refuses ordinary
   * commands on a subscriber — so this reads a version key instead: one cheap GET every five
   * seconds per instance, against a reload that used to take two minutes. Five seconds is not a
   * difference anybody tuning a lexicon can feel, and it costs no new connection and no listener
   * to leak.
   */
  private static readonly VERSION_CHECK_MS = 5_000;

  /** Bumped by the admin API whenever a term is written. */
  static readonly VERSION_KEY = 'risk-terms:version';

  // Additive score thresholds.
  private static readonly THRESHOLDS: Array<[number, RiskLevel]> = [
    [90, RiskLevel.CRITICAL],
    [55, RiskLevel.HIGH],
    [30, RiskLevel.MEDIUM],
    [1, RiskLevel.LOW],
  ];

  constructor(
    private readonly database: PrismaService,
    private readonly cache: CacheService,
  ) {}

  private async ensureLoaded(): Promise<void> {
    const fresh = this.lexicon.length && Date.now() - this.loadedAt < RiskScannerService.TTL_MS;

    if (fresh && !(await this.lexiconChanged())) return;

    // Read before the rows, so the copy is tagged with the version it was built from. Without
    // this a reload triggered by the two-minute cache left `loadedVersion` stale, and the next
    // version check saw a difference that was not one and reloaded the whole table again.
    this.loadedVersion = await this.cache
      .get<string>(RiskScannerService.VERSION_KEY)
      .catch(() => null);

    const terms = await this.database.riskTerm.findMany({ where: { isActive: true } });

    this.lexicon = terms.map(term => ({
      category: term.category,
      pattern: term.pattern,
      weight: term.weight,
      // Normalised on both sides. The pattern is stored normalised, but normalising again here
      // costs nothing and means a row written before that rule existed still matches.
      //
      // Word boundaries, so "scam" does not fire on "scamper" and an apostrophe inside a phrase
      // still matches.
      regex: new RegExp(
        `(?<![\\w])${escapeRegExp(normaliseForScanning(term.pattern))}(?![\\w])`,
        'i',
      ),
    }));
    this.loadedAt = Date.now();
  }

  /**
   * Whether somebody has changed the lexicon since this copy was built.
   *
   * Asked at most once every five seconds, and never on the request that has just loaded. A
   * failure is treated as "unchanged": a Redis blip must not turn every scan into a full reload of
   * the table.
   */
  private async lexiconChanged(): Promise<boolean> {
    if (Date.now() - this.versionCheckedAt < RiskScannerService.VERSION_CHECK_MS) return false;

    this.versionCheckedAt = Date.now();

    try {
      const version = await this.cache.get<string>(RiskScannerService.VERSION_KEY);

      if (version === this.loadedVersion) return false;

      this.loadedVersion = version;

      // The first check after a restart finds a version it has never seen. Reloading once there is
      // harmless and saves a branch that would have to guess.
      return true;
    } catch {
      return false;
    }
  }

  async scan(...texts: Array<string | null | undefined>): Promise<RiskAssessment> {
    await this.ensureLoaded();

    // Normalised, not merely lowercased. Until this, "c4sh", "s\u200bcam" and a full-width
    // rendering of the same word all went straight past a lexicon that was looking for the plain
    // spelling — the filter was one keystroke away from being switched off by anybody who knew.
    const haystack = normaliseForScanning(texts.filter(Boolean).join(' \n '));

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

    // The category is the heaviest one matched, not the first — a post mentioning both a scam and self-harm is a self-harm case.
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
