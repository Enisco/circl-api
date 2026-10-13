import { Injectable, Logger } from '@nestjs/common';
import { RiskCategory, RiskLevel } from '@prisma/client';
import { CacheService, PrismaService } from '@/infrastructure';
import { SYSTEM_CONFIG_KEYS } from '@/common';
import { normaliseForScanning, normaliseForScanningWithOffsets } from './text-normalisation';
import { SystemConfigService } from './system-config.service';
import { TierThresholds } from './safety-scoring';

export interface RiskSignal {
  /** The term that matched, so a reviewer's decision can be recorded against it (§4.5). */
  termId: string;
  category: RiskCategory;
  pattern: string;
  weight: number;
  /**
   * Which field it matched in. Null for `scan()`, which is handed loose strings; the content
   * pipeline uses `scanFields` and names them, because "the phrase is in the title" and "the
   * phrase is in a paragraph halfway down" are different things to a reviewer.
   */
  field: string | null;
  /**
   * Where it matched, as UTF-16 offsets into the field's **original** text — the same string
   * §5.9's `contentDetail.body[field]` returns, so the portal highlights the phrase by slicing it.
   *
   * Matching runs on normalised text, whose indices are not the original's, so these come from
   * `normaliseForScanningWithOffsets`. Null in the rare case where that alignment cannot be
   * proven: a highlight in the wrong place is worse than no highlight, because it accuses the
   * member of writing something they did not.
   */
  start: number | null;
  end: number | null;
}

export interface RiskAssessment {
  level: RiskLevel;
  category: RiskCategory | null;
  score: number;
  /** The matched phrases, so a reviewer can see why this reached their queue. */
  signals: RiskSignal[];
  /**
   * Whether one matched term is severe enough to escalate on its own — a single phrase weighing
   * as much as the high threshold, in a safeguarding category (§6.3's fourth rule).
   */
  criticalHit: boolean;
}

/**
 * Raised only on a cold start with no lexicon in memory and a database that will not answer.
 *
 * A distinct type because the caller's response to it is specific (§6.7): accept the write,
 * record the content as unscanned, keep it out of feeds, and let the rescan job come back to it.
 * An ordinary error there would fail the member's post.
 */
export class LexiconUnavailableError extends Error {
  constructor() {
    super('The risk lexicon could not be loaded.');
  }
}

/** Circl Guard's risk scanner. */
@Injectable()
export class RiskScannerService {
  private readonly logger = new Logger(RiskScannerService.name);

  private lexicon: Array<{
    id: string;
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

  constructor(
    private readonly database: PrismaService,
    private readonly cache: CacheService,
    private readonly config: SystemConfigService,
  ) {}

  /**
   * The thresholds, from `safety.tierThresholds` rather than from four constants in this file.
   *
   * §6.3 asks for this explicitly, and the reason is operational: a lexicon is retuned by the
   * people reading the queue, and thresholds that need a deploy are thresholds nobody retunes.
   * `SystemConfigService` caches them, so this is not a database read per scan.
   */
  async thresholds(): Promise<TierThresholds> {
    return this.config.get(SYSTEM_CONFIG_KEYS.TIER_THRESHOLDS);
  }

  /** The categories that escalate rather than merely score (`safety.criticalCategories`). */
  async criticalCategories(): Promise<string[]> {
    return this.config.get(SYSTEM_CONFIG_KEYS.CRITICAL_CATEGORIES);
  }

  private levelFor(score: number, thresholds: TierThresholds): RiskLevel {
    if (score >= thresholds.critical) return RiskLevel.CRITICAL;
    if (score >= thresholds.high) return RiskLevel.HIGH;
    if (score >= thresholds.medium) return RiskLevel.MEDIUM;
    if (score >= thresholds.low) return RiskLevel.LOW;

    return RiskLevel.NONE;
  }

  private async ensureLoaded(): Promise<void> {
    const fresh = this.lexicon.length && Date.now() - this.loadedAt < RiskScannerService.TTL_MS;

    if (fresh && !(await this.lexiconChanged())) return;

    // Read before the rows, so the copy is tagged with the version it was built from. Without
    // this a reload triggered by the two-minute cache left `loadedVersion` stale, and the next
    // version check saw a difference that was not one and reloaded the whole table again.
    this.loadedVersion = await this.cache
      .get<string>(RiskScannerService.VERSION_KEY)
      .catch(() => null);

    let terms: Array<{ id: string; category: RiskCategory; pattern: string; weight: number }>;

    try {
      terms = await this.database.riskTerm.findMany({ where: { isActive: true } });
    } catch (error) {
      // §6.7: a lexicon that cannot be read must not take posting down with it. An instance keeps
      // the copy it already has — a two-minute-old lexicon is a far better answer than refusing
      // to accept a request — and only a cold start has nothing to fall back on, which the caller
      // turns into "unscanned, limited, try again" rather than an error for the member.
      if (this.lexicon.length) {
        this.logger.warn(`Keeping the loaded lexicon: ${(error as Error).message}`);
        this.loadedAt = Date.now();

        return;
      }

      throw new LexiconUnavailableError();
    }

    this.lexicon = terms.map(term => ({
      id: term.id,
      category: term.category,
      pattern: term.pattern,
      weight: term.weight,
      // Normalised on both sides. The pattern is stored normalised, but normalising again here
      // costs nothing and means a row written before that rule existed still matches.
      //
      // Word boundaries, so "scam" does not fire on "scamper" and an apostrophe inside a phrase
      // still matches.
      // Global as well as case-insensitive, because the scan now reports *where* each phrase
      // matched and `matchAll` requires it. `matchAll` works on its own copy of the regex, so the
      // shared `lastIndex` that a bare `exec` loop would have left behind is not a hazard here.
      regex: new RegExp(
        `(?<![\\w])${escapeRegExp(normaliseForScanning(term.pattern))}(?![\\w])`,
        'gi',
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
    return this.scanFields(Object.fromEntries(texts.map((text, index) => [String(index), text])));
  }

  /**
   * The same scan, over named fields.
   *
   * Per field rather than over one joined string, because a signal is evidence and a reviewer
   * needs to know where it is. It also stops a phrase being assembled across a boundary: joining
   * a title ending "self" to a body starting "harm" used to make a match out of two innocent
   * halves.
   */
  async scanFields(fields: Record<string, string | null | undefined>): Promise<RiskAssessment> {
    await this.ensureLoaded();

    const thresholds = await this.thresholds();
    const critical = await this.criticalCategories();
    const empty: RiskAssessment = {
      level: RiskLevel.NONE,
      category: null,
      score: 0,
      signals: [],
      criticalHit: false,
    };

    const signals: RiskSignal[] = [];
    const perCategory = new Map<RiskCategory, number>();
    let score = 0;
    let criticalHit = false;

    // A term scores **once**, however many fields it appears in, while every occurrence is
    // recorded as its own signal. Scoring per occurrence looked reasonable and was not: a post
    // that said "immigration raid" in its title and again in its body scored 100 instead of 50
    // and crossed two tier boundaries on one phrase, which is the difference between a flagged
    // post and an opened Guard case. Repetition is not twice the risk.
    const scored = new Set<string>();

    for (const [field, text] of Object.entries(fields)) {
      if (!text) continue;

      // Normalised, not merely lowercased. Until this, "c4sh", "s\u200bcam" and a full-width
      // rendering of the same word all went straight past a lexicon that was looking for the plain
      // spelling — the filter was one keystroke away from being switched off by anybody who knew.
      const { text: haystack, map } = normaliseForScanningWithOffsets(text);

      if (!haystack.trim()) continue;

      for (const term of this.lexicon) {
        // Every occurrence, not merely the first: a reviewer highlighting "the phrase that
        // matched" wants all of them, and the scoring below is deliberately per term rather than
        // per occurrence so this costs nothing but evidence.
        const hits = [...haystack.matchAll(term.regex)];

        if (!hits.length) continue;

        for (const hit of hits) {
          signals.push({
            termId: term.id,
            category: term.category,
            pattern: term.pattern,
            weight: term.weight,
            field: Number.isNaN(Number(field)) ? field : null,
            start: map ? map[hit.index] : null,
            end: map ? map[hit.index + hit[0].length] : null,
          });
        }

        if (scored.has(term.id)) continue;

        scored.add(term.id);
        score += term.weight;
        perCategory.set(term.category, (perCategory.get(term.category) ?? 0) + term.weight);

        if (term.weight >= thresholds.high && critical.includes(term.category)) criticalHit = true;
      }
    }

    if (!signals.length) return empty;

    // The category is the heaviest one matched, not the first — a post mentioning both a scam and self-harm is a self-harm case.
    const category = [...perCategory.entries()].sort((a, b) => b[1] - a[1])[0][0];

    return {
      level: this.levelFor(score, thresholds),
      category,
      score,
      signals,
      criticalHit,
    };
  }

  /**
   * The lexicon run against one piece of text, with the offsets of every match (§5.13's tester).
   *
   * Separate from `scan` because the two answer different questions. `scan` produces a verdict and
   * records which phrases fired; this shows staff **where** they fired, so a false positive can be
   * seen rather than argued about — the usual one is a phrase that matched inside a longer
   * innocent word, and a list of pattern names will never show that.
   *
   * ### The offsets are into `normalisedText`, not the text that was submitted
   *
   * Matching happens on normalised text (NFKC, invisible characters removed, case folded,
   * leetspeak folded inside words, whitespace collapsed), and every one of those steps can change
   * the length of the string. So an index taken here does not point at the same character in the
   * original, and returning one as though it did would put a highlight in the wrong place — worse
   * on exactly the evasive input the tester exists to study, because that is where normalisation
   * changes the most.
   *
   * So the normalised text is returned with them, and the caller highlights against that. It also
   * answers a question staff ask constantly: what does the scanner actually see?
   *
   * `draft` is a term that has not been saved, so a weight can be tried before it is live.
   */
  async test(
    text: string,
    draft?: { category: RiskCategory; pattern: string; weight: number } | null,
  ) {
    await this.ensureLoaded();

    const thresholds = await this.thresholds();
    const critical = await this.criticalCategories();
    const normalisedText = normaliseForScanning(text);

    const candidates = [
      ...this.lexicon.map(term => ({
        termId: term.id as string,
        category: term.category,
        pattern: term.pattern,
        weight: term.weight,
        regex: term.regex,
      })),
      ...(draft
        ? [
            {
              termId: 'draft',
              category: draft.category,
              pattern: draft.pattern,
              weight: draft.weight,
              // Built the same way `ensureLoaded` builds the live ones, so a draft is tested under
              // exactly the rules it would run under once saved — whole-word, literal, normalised.
              regex: new RegExp(
                `(?<![\\w])${escapeRegExp(normaliseForScanning(draft.pattern))}(?![\\w])`,
                'gi',
              ),
            },
          ]
        : []),
    ];

    const matches: Array<{
      termId: string;
      pattern: string;
      category: RiskCategory;
      weight: number;
      start: number;
      end: number;
    }> = [];
    const perCategory = new Map<RiskCategory, number>();
    const scored = new Set<string>();
    let score = 0;
    let criticalHit = false;

    for (const term of candidates) {
      // A fresh regex per term: the live lexicon's are shared and carry `lastIndex` between
      // calls, so reusing one here would start the next search part-way through the string and
      // skip matches depending on what was tested a moment ago.
      const regex = new RegExp(term.regex.source, 'gi');
      let hit: RegExpExecArray | null;
      let found = false;

      while ((hit = regex.exec(normalisedText)) !== null) {
        matches.push({
          termId: term.termId,
          pattern: term.pattern,
          category: term.category,
          weight: term.weight,
          start: hit.index,
          end: hit.index + hit[0].length,
        });
        found = true;

        // A zero-width match would otherwise loop forever. Not reachable with a non-empty
        // pattern, and patterns are length-checked on write — but this is a loop over
        // attacker-adjacent input and the cost of being sure is one line.
        if (hit[0].length === 0) regex.lastIndex += 1;
      }

      // Scored once however many times it appears, which is what `scanFields` does: repetition is
      // not twice the risk, and a tester that scored per occurrence would advise a weight that is
      // wrong for the scanner it is advising about.
      if (found && !scored.has(term.termId)) {
        scored.add(term.termId);
        score += term.weight;
        perCategory.set(term.category, (perCategory.get(term.category) ?? 0) + term.weight);

        if (term.weight >= thresholds.high && critical.includes(term.category)) criticalHit = true;
      }
    }

    const category = perCategory.size
      ? [...perCategory.entries()].sort((a, b) => b[1] - a[1])[0][0]
      : null;

    return {
      normalisedText,
      score,
      level: matches.length ? this.levelFor(score, thresholds) : RiskLevel.NONE,
      category,
      criticalHit,
      // Ordered by where they appear, so the list reads alongside the text rather than in
      // lexicon order.
      matches: matches.sort((a, b) => a.start - b.start || a.end - b.end),
    };
  }

  /** Whether an assessment is severe enough to jump the moderation queue. */
  isUrgent(assessment: RiskAssessment): boolean {
    return assessment.level === RiskLevel.HIGH || assessment.level === RiskLevel.CRITICAL;
  }
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
