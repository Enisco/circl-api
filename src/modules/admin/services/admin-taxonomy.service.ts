import { Injectable } from '@nestjs/common';
import { Prisma, RiskCategory, RiskTerm, TaxonomyKind } from '@prisma/client';
import { CacheService, PrismaService } from '@/infrastructure';
import { AuditService } from '../audit/audit.service';
import {
  ApiErrorCode,
  ApiException,
  SYSTEM_CONFIG_KEYS,
  buildPageMeta,
  toJsonOrUndefined,
} from '@/common';
import {
  MediaService,
  RiskScannerService,
  SafetyClassifierService,
  SystemConfigService,
  TaxonomyService,
  actionFor,
  normalisePattern,
  scoreOf,
} from '@/modules/platform/shared';
import {
  ListRiskTermsDto,
  PatchRiskTermDto,
  RISK_TERM_SORTS,
  TestPhraseDto,
  UpsertRiskTermDto,
  UpsertTaxonomyTermDto,
} from '../dtos/admin.dto';
import { staffRefSelect, toStaffRef } from '../serializers/admin-staff.serializer';

/**
 * How many resolved hits a term needs before its false-positive rate means anything.
 *
 * §5.13's rule. Under this, the rate is null rather than a number: a single reviewer's first
 * decision about a phrase is not a measurement of it, and a list sorted on a 1-of-1 rate would
 * put the newest terms at the top and call them the worst.
 */
const MIN_RESOLVED_FOR_RATE = 5;

/** Taxonomy and lexicon administration. */
@Injectable()
export class AdminTaxonomyService {
  constructor(
    private readonly database: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly risk: RiskScannerService,
    private readonly classifier: SafetyClassifierService,
    private readonly config: SystemConfigService,
    private readonly media: MediaService,
  ) {}

  async list(kind: TaxonomyKind) {
    const terms = await this.database.taxonomyTerm.findMany({
      where: { kind },
      orderBy: { sort: 'asc' },
    });

    return terms.map(term => ({
      id: term.id,
      kind: term.kind,
      code: term.code,
      label: term.label,
      description: term.description,
      sort: term.sort,
      isActive: term.isActive,
      metadata: term.metadata,
      updatedAt: term.updatedAt.toISOString(),
    }));
  }

  async upsert(dto: UpsertTaxonomyTermDto) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(dto.code)) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'A code must be UPPER_SNAKE.',
        { details: [{ field: 'code', message: 'Use UPPER_SNAKE, e.g. AIRPORT_PICKUP.' }] },
      );
    }

    const term = await this.database.taxonomyTerm.upsert({
      where: { kind_code: { kind: dto.kind, code: dto.code } },
      update: {
        label: dto.label,
        description: dto.description ?? null,
        ...(dto.sort !== undefined ? { sort: dto.sort } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.metadata !== undefined ? { metadata: toJsonOrUndefined(dto.metadata) } : {}),
      },
      create: {
        kind: dto.kind,
        code: dto.code,
        label: dto.label,
        description: dto.description ?? null,
        sort: dto.sort ?? 0,
        isActive: dto.isActive ?? true,
        metadata: toJsonOrUndefined(dto.metadata),
      },
    });

    // Bumps the version stamp, which invalidates every process's cache and the client's ETag in one write.
    const version = await this.taxonomy.bumpVersion();

    return { term, version: version.toISOString() };
  }

  /** Deactivates rather than deletes. */
  async deactivate(kind: TaxonomyKind, code: string) {
    const term = await this.database.taxonomyTerm.findUnique({
      where: { kind_code: { kind, code } },
    });

    if (!term) throw ApiException.notFound('That term could not be found.');

    await this.database.taxonomyTerm.update({
      where: { id: term.id },
      data: { isActive: false },
    });

    const version = await this.taxonomy.bumpVersion();

    return { kind, code, isActive: false, version: version.toISOString() };
  }

  // ─── Guard lexicon ─────────────────────────────────────────────────────────

  async listRiskTerms(query: ListRiskTermsDto) {
    const where: Prisma.RiskTermWhereInput = {
      ...(query.category?.length
        ? { category: { in: query.category.map(code => this.assertRiskCategory(code)) } }
        : {}),
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...(query.q ? { pattern: { contains: normalisePattern(query.q) } } : {}),
    };

    const sort = query.sortField([...RISK_TERM_SORTS], 'pattern');
    const direction = query.order ?? (sort === 'pattern' ? 'asc' : 'desc');

    const [total, rows] = await Promise.all([
      this.database.riskTerm.count({ where }),
      this.database.riskTerm.findMany({
        where,
        // `falsePositiveRate` is derived from two columns, so it cannot be an ORDER BY. The rows
        // for that sort are ordered in memory below, over the page the filters selected — which
        // is the honest limit of sorting a derived field without storing it.
        orderBy:
          sort === 'falsePositiveRate'
            ? [{ falsePositiveCount: direction }, { pattern: 'asc' }]
            : sort === 'pattern'
              ? [{ category: 'asc' }, { pattern: direction }]
              : [{ [sort]: direction }, { pattern: 'asc' }],
        skip: (query.currentPage - 1) * query.size,
        take: query.size,
      }),
    ]);

    const staff = await this.database.user.findMany({
      where: {
        id: {
          in: [...new Set(rows.map(row => row.updatedById).filter((id): id is string => !!id))],
        },
      },
      select: staffRefSelect,
    });
    const byId = new Map(staff.map(person => [person.id, person]));

    const data = rows.map(row => this.riskTermView(row, byId));

    if (sort === 'falsePositiveRate') {
      // Nulls last, whichever direction: a term with too few resolved hits to have a rate is not
      // "the best" or "the worst", it is unmeasured, and sorting it to either end of the list
      // would read as a judgement nothing has made.
      data.sort((a, b) => {
        if (a.falsePositiveRate === null) return b.falsePositiveRate === null ? 0 : 1;
        if (b.falsePositiveRate === null) return -1;

        return direction === 'asc'
          ? a.falsePositiveRate - b.falsePositiveRate
          : b.falsePositiveRate - a.falsePositiveRate;
      });
    }

    return {
      data,
      meta: buildPageMeta({ currentPage: query.currentPage, perPage: query.size }, total),
    };
  }

  /**
   * One phrase against one piece of text, before it goes live (§5.13).
   *
   * Not audited and not rate-limited here (the route carries 60/min): it changes nothing. What it
   * is *for* is the false positive — the phrase that matched inside a longer innocent word — which
   * a list of term names will never show and an offset into the text will.
   *
   * The offsets index `lexicon.normalisedText`, not the text submitted: matching happens on
   * normalised text and every normalisation step can change the string's length, so an index taken
   * against one does not point at the same character in the other. Returning it as though it did
   * would misplace a highlight, worst on exactly the evasive input this exists to study.
   */
  async testPhrase(dto: TestPhraseDto) {
    const draft = dto.draftTerm
      ? {
          category: this.assertRiskCategory(dto.draftTerm.category),
          pattern: dto.draftTerm.pattern,
          weight: dto.draftTerm.weight,
        }
      : null;

    if (draft) {
      const normalised = normalisePattern(draft.pattern);

      this.assertPatternLength(normalised, draft.pattern);
      draft.pattern = normalised;
    }

    const [lexicon, thresholds, criticalCategories, settings] = await Promise.all([
      this.risk.test(dto.text, draft),
      this.risk.thresholds(),
      this.risk.criticalCategories(),
      this.config.get(SYSTEM_CONFIG_KEYS.CLASSIFIER),
    ]);

    const classified = dto.includeClassifier
      ? await this.classifier.classify({ fields: { text: dto.text }, mediaKeys: [] })
      : null;

    const verdict = scoreOf({
      lexiconScore: lexicon.score,
      lexiconCategory: lexicon.category,
      lexiconCriticalHit: lexicon.criticalHit,
      classifier: classified?.result ?? null,
      thresholds,
      criticalCategories,
      weight: settings.weight,
    });

    return {
      lexicon: {
        normalisedText: lexicon.normalisedText,
        score: lexicon.score,
        level: lexicon.level,
        category: lexicon.category,
        matches: lexicon.matches,
      },
      classifier: classified?.result
        ? {
            // `flagged` is the spec's name for it; the column it comes from is `confident` —
            // "any single category was confident on its own". The score and category come too,
            // because a bare boolean beside a `finalScore` does not explain the number.
            flagged: classified.result.confident,
            scores: classified.result.scores,
            score: classified.result.score,
            category: classified.result.category,
          }
        : null,
      // Said plainly rather than left to be inferred from `classifier: null`, which has two
      // meanings: the caller did not ask for it, or it was asked for and did not answer. Those
      // lead to different conclusions about the score beside them.
      classifierRan: Boolean(classified?.result),
      classifierError: classified?.error ?? null,
      finalScore: verdict.finalScore,
      tier: verdict.tier,
      degraded: verdict.degraded,
      action: actionFor(verdict.tier),
    };
  }

  /**
   * Adds a phrase, or retunes the one already stored for that category and phrase.
   *
   * The pattern is normalised with the function the scanner applies to member text, and its length
   * is checked **after** that: a phrase that normalises to one character is not a phrase, however
   * long it looked when it was typed. Stored patterns were previously only lowercased, so one
   * carrying a double space, a zero-width character, a different Unicode composition or a
   * leetspeak digit could never match — and failed silently, sitting in the list looking active
   * with a hit count of zero (§5.13 addendum).
   */
  async upsertRiskTerm(dto: UpsertRiskTermDto) {
    const category = this.assertRiskCategory(dto.category);
    const pattern = normalisePattern(dto.pattern);

    this.assertPatternLength(pattern, dto.pattern);

    const existing = await this.database.riskTerm.findUnique({
      where: { category_pattern: { category, pattern } },
    });

    const { result } = await this.audit.mutate(
      (term: RiskTerm) => ({
        action: 'risk_term.upserted',
        targetType: 'RISK_TERM',
        targetId: term.id,
        targetLabel: `${category}: ${pattern}`,
        before: existing ? this.riskTermState(existing) : undefined,
        after: this.riskTermState(term),
      }),
      async tx =>
        tx.riskTerm.upsert({
          where: { category_pattern: { category, pattern } },
          update: {
            ...(dto.weight !== undefined ? { weight: dto.weight } : {}),
            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
            ...(dto.notes !== undefined ? { notes: dto.notes || null } : {}),
          },
          create: {
            category,
            pattern,
            weight: dto.weight ?? 10,
            isActive: dto.isActive ?? true,
            notes: dto.notes || null,
          },
        }),
    );

    await this.announceLexiconChange();

    return this.riskTermView(result);
  }

  /**
   * Retunes one term by id. `pattern` is not accepted.
   *
   * Changing a phrase in place would hand one phrase's evidence to another: the hit count and the
   * false-positive rate are the numbers staff use to decide whether a term is pulling its weight,
   * and they are about an exact phrase. To change the words, deactivate the term and add a new one
   * (§5.13 addendum). The DTO simply has no `pattern` field, so the global whitelist refuses it
   * with a 400 naming the field rather than ignoring it.
   */
  async patchRiskTerm(id: string, dto: PatchRiskTermDto) {
    const term = await this.database.riskTerm.findUnique({ where: { id } });

    if (!term) throw ApiException.notFound('That term could not be found.');

    const category = dto.category ? this.assertRiskCategory(dto.category) : term.category;

    // Moving a phrase to another category can collide with a phrase already there. The unique key
    // is (category, pattern), so without this the write fails on a constraint and the caller gets
    // a 500 where they should get "that already exists".
    if (category !== term.category) {
      const clash = await this.database.riskTerm.findUnique({
        where: { category_pattern: { category, pattern: term.pattern } },
      });

      if (clash) {
        throw ApiException.conflict(
          ApiErrorCode.CONFLICT,
          `"${term.pattern}" is already a ${category} term.`,
          { data: { id: clash.id } },
        );
      }
    }

    const { result } = await this.audit.mutate(
      (updated: RiskTerm) => ({
        action: 'risk_term.upserted',
        targetType: 'RISK_TERM',
        targetId: id,
        targetLabel: `${term.category}: ${term.pattern}`,
        before: this.riskTermState(term),
        after: this.riskTermState(updated),
      }),
      async tx =>
        tx.riskTerm.update({
          where: { id },
          data: {
            ...(dto.category !== undefined ? { category } : {}),
            ...(dto.weight !== undefined ? { weight: dto.weight } : {}),
            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
            ...(dto.notes !== undefined ? { notes: dto.notes || null } : {}),
          },
        }),
    );

    await this.announceLexiconChange();

    return this.riskTermView(result);
  }

  async removeRiskTerm(id: string) {
    const term = await this.database.riskTerm.findUnique({ where: { id } });

    if (!term) throw ApiException.notFound('That term could not be found.');

    const { result } = await this.audit.mutate(
      (updated: RiskTerm) => ({
        action: 'risk_term.deactivated',
        targetType: 'RISK_TERM',
        targetId: id,
        targetLabel: `${term.category}: ${term.pattern}`,
        before: this.riskTermState(term),
        after: this.riskTermState(updated),
      }),
      // Deactivated rather than deleted, so a phrase staff turned off stays off through the next
      // seed run.
      async tx => tx.riskTerm.update({ where: { id }, data: { isActive: false } }),
    );

    await this.announceLexiconChange();

    return this.riskTermView(result);
  }

  private assertRiskCategory(value: string): RiskCategory {
    if (!Object.values(RiskCategory).includes(value as RiskCategory)) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        `"${value}" is not a risk category.`,
        { details: [{ field: 'category', message: 'Not a valid risk category.' }] },
      );
    }

    return value as RiskCategory;
  }

  /**
   * Two to a hundred and twenty characters, measured on the normalised form.
   *
   * The message says what it normalised to, because the surprising case is a phrase that looked
   * fine and collapsed — a staff member who pastes something with invisible characters in it needs
   * to see what the scanner would actually have been looking for.
   */
  private assertPatternLength(pattern: string, asTyped: string): void {
    if (pattern.length >= 2 && pattern.length <= 120) return;

    throw ApiException.badRequest(
      ApiErrorCode.VALIDATION_FAILED,
      pattern.length < 2
        ? `That phrase comes to ${JSON.stringify(pattern)} once normalised, which is too short to match on.`
        : 'That phrase is longer than 120 characters once normalised.',
      {
        details: [
          {
            field: 'pattern',
            message: `Use 2–120 characters. ${JSON.stringify(asTyped)} normalises to ${JSON.stringify(pattern)}.`,
          },
        ],
      },
    );
  }

  /**
   * Tells every instance its copy of the lexicon is stale.
   *
   * Each process holds the lexicon in memory behind a two-minute cache, so without this a phrase
   * added the moment staff saw it used would not be matching for another two minutes — on some
   * instances and not others, which is worse than a uniform delay because it is not reproducible.
   * The scanner reads this version at most once every five seconds.
   */
  private async announceLexiconChange(): Promise<void> {
    await this.cache
      .set(RiskScannerService.VERSION_KEY, new Date().toISOString())
      .catch(() => undefined);
  }

  /**
   * One term, with the evidence staff judge it on (§5.13's `RiskTermView`).
   *
   * The counts were in the table and absent from the response, which made the lexicon screen a
   * list of phrases and weights with no way to tell a term that is working from one that is
   * wasting reviewers' time — the exact question the screen exists to answer.
   */
  private riskTermView(
    term: {
      id: string;
      category: RiskCategory;
      pattern: string;
      weight: number;
      isActive: boolean;
      notes: string | null;
      updatedAt: Date;
      updatedById?: string | null;
      hitCount?: number;
      confirmedCount?: number;
      falsePositiveCount?: number;
      lastHitAt?: Date | null;
    },
    staff?: Map<string, Parameters<typeof toStaffRef>[0]>,
  ) {
    const confirmed = term.confirmedCount ?? 0;
    const falsePositives = term.falsePositiveCount ?? 0;
    const resolved = confirmed + falsePositives;

    return {
      id: term.id,
      category: term.category,
      pattern: term.pattern,
      weight: term.weight,
      isActive: term.isActive,
      notes: term.notes,
      hitCount: term.hitCount ?? 0,
      confirmedCount: confirmed,
      falsePositiveCount: falsePositives,
      // Derived rather than stored: it is `hitCount` minus the two resolved counts by definition,
      // and a fourth counter is a fourth thing that can fall out of step with the other three.
      pendingCount: Math.max(0, (term.hitCount ?? 0) - resolved),
      // Null under five resolved hits, deliberately. One false positive out of one hit is not a
      // 100% false-positive rate, but it renders as one — and a term would be retired on the
      // strength of a single reviewer's first decision about it.
      falsePositiveRate: resolved >= MIN_RESOLVED_FOR_RATE ? falsePositives / resolved : null,
      lastHitAt: term.lastHitAt?.toISOString() ?? null,
      updatedAt: term.updatedAt.toISOString(),
      updatedBy:
        term.updatedById && staff?.has(term.updatedById)
          ? toStaffRef(staff.get(term.updatedById)!, this.media.sign)
          : null,
    };
  }

  /** What an audit entry records about a term: the fields a change can touch. */
  private riskTermState(term: {
    category: RiskCategory;
    pattern: string;
    weight: number;
    isActive: boolean;
    notes: string | null;
  }) {
    return {
      category: term.category,
      pattern: term.pattern,
      weight: term.weight,
      isActive: term.isActive,
      notes: term.notes,
    };
  }
}
