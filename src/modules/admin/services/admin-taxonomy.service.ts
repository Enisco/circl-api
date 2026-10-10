import { Injectable } from '@nestjs/common';
import { RiskCategory, RiskTerm, TaxonomyKind } from '@prisma/client';
import { CacheService, PrismaService } from '@/infrastructure';
import { AuditService } from '../audit/audit.service';
import { ApiErrorCode, ApiException, buildPageMeta, toJsonOrUndefined } from '@/common';
import { RiskScannerService, TaxonomyService, normalisePattern } from '@/modules/platform/shared';
import {
  ListRiskTermsDto,
  PatchRiskTermDto,
  UpsertRiskTermDto,
  UpsertTaxonomyTermDto,
} from '../dtos/admin.dto';

/** Taxonomy and lexicon administration. */
@Injectable()
export class AdminTaxonomyService {
  constructor(
    private readonly database: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
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
    const [total, rows] = await this.database.$transaction([
      this.database.riskTerm.count(),
      this.database.riskTerm.findMany({
        orderBy: [{ category: 'asc' }, { weight: 'desc' }],
        skip: query.skip,
        take: query.take,
      }),
    ]);

    return {
      data: rows.map(row => this.riskTermView(row)),
      meta: buildPageMeta(query, total),
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

  private riskTermView(term: {
    id: string;
    category: RiskCategory;
    pattern: string;
    weight: number;
    isActive: boolean;
    notes: string | null;
    updatedAt: Date;
  }) {
    return {
      id: term.id,
      category: term.category,
      pattern: term.pattern,
      weight: term.weight,
      isActive: term.isActive,
      notes: term.notes,
      updatedAt: term.updatedAt.toISOString(),
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
