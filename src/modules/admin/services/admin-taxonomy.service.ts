import { Injectable } from '@nestjs/common';
import { Prisma, RiskCategory, RiskTerm, TaxonomyKind, TaxonomyTerm } from '@prisma/client';
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
/**
 * The thirteen the portal edits (§5.19, §12).
 *
 * The enum holds more — sort options, feed types, item units, notification categories — and those
 * stay seed-only: they are vocabularies the **client matches on**, so rewording one from a
 * configuration screen would change behaviour rather than wording.
 */
export const EDITABLE_KINDS: TaxonomyKind[] = [
  TaxonomyKind.COMMUNITY_CATEGORY,
  TaxonomyKind.GUIDE_TOPIC,
  TaxonomyKind.PROFESSION,
  TaxonomyKind.HERITAGE_TAG,
  TaxonomyKind.JOURNEY_STAGE,
  TaxonomyKind.INTEREST,
  TaxonomyKind.HOBBY,
  TaxonomyKind.LANGUAGE,
  TaxonomyKind.COUNTRY_OF_ORIGIN,
  TaxonomyKind.CONNECTION_TYPE,
  TaxonomyKind.ITEM_CATEGORY,
  TaxonomyKind.STORE_TYPE,
  TaxonomyKind.GUARD_CATEGORY,
  TaxonomyKind.MANAGED_CATEGORY,
];

const labelOfKind = (kind: TaxonomyKind): string =>
  kind.charAt(0) + kind.slice(1).toLowerCase().replace(/_/g, ' ');

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

  /**
   * The kinds the portal edits, with how much is in each (§5.19).
   *
   * A declared list rather than every value of the enum: the enum carries vocabularies that are
   * seed-only — sort options, feed types, item units — and offering them for editing invites
   * somebody to reword a value the client matches on. §5.19 names the thirteen.
   *
   * This route exists because it did not: `GET admin/taxonomy/kinds` fell through to
   * `taxonomy/:kind`, whose parameter was unvalidated, so the portal's first call on the
   * configuration screen was a 500 — now it is a list, and `:kind` is an enum pipe.
   */
  async kinds(): Promise<
    Array<{ kind: TaxonomyKind; label: string; termCount: number; activeCount: number }>
  > {
    const counts = await this.database.taxonomyTerm.groupBy({
      by: ['kind', 'isActive'],
      _count: { _all: true },
    });

    return EDITABLE_KINDS.map(kind => {
      const rows = counts.filter(row => row.kind === kind);

      return {
        kind,
        label: labelOfKind(kind),
        termCount: rows.reduce((total, row) => total + row._count._all, 0),
        activeCount: rows
          .filter(row => row.isActive)
          .reduce((total, row) => total + row._count._all, 0),
      };
    });
  }

  async list(kind: TaxonomyKind, includeUsage = false) {
    const terms = await this.database.taxonomyTerm.findMany({
      where: { kind },
      orderBy: { sort: 'asc' },
    });
    const usage = includeUsage
      ? await this.usageFor(
          kind,
          terms.map(term => term.code),
        )
      : null;

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
      ...(usage ? { usageCount: usage.get(term.code) ?? 0 } : {}),
    }));
  }

  /**
   * The whole list in the order it should be in (§5.19).
   *
   * Every code of the kind, exactly once. A partial list is refused rather than applied to what it
   * covers: `sort` decides what a member sees first in a picker, and a reorder that silently left
   * four terms at position zero would put them all first.
   *
   * One version bump for the whole move, not one per term — the stamp invalidates every cache and
   * every client ETag, and doing it fourteen times would be fourteen cold caches.
   */
  async reorder(kind: TaxonomyKind, codes: string[]) {
    const terms = await this.database.taxonomyTerm.findMany({
      where: { kind },
      select: { id: true, code: true },
    });
    const mine = new Set(terms.map(term => term.code));
    const sent = new Set(codes);

    if (sent.size !== codes.length || mine.size !== sent.size || codes.some(c => !mine.has(c))) {
      throw ApiException.badRequest(
        ApiErrorCode.VALIDATION_FAILED,
        `Send every ${kind} code, once each, in the order you want them.`,
        {
          data: { expected: mine.size, sent: codes.length },
          details: [{ field: 'codes', message: `Expected ${mine.size} codes, all of this kind.` }],
        },
      );
    }

    const byCode = new Map(terms.map(term => [term.code, term.id]));

    await this.audit.mutate(
      {
        action: 'taxonomy.reordered',
        targetType: 'TAXONOMY_KIND',
        targetId: kind,
        targetLabel: labelOfKind(kind),
        after: { codes },
      },
      async tx => {
        for (const [index, code] of codes.entries()) {
          await tx.taxonomyTerm.update({ where: { id: byCode.get(code) }, data: { sort: index } });
        }

        return { kind };
      },
    );

    const version = await this.taxonomy.bumpVersion();

    return { terms: await this.list(kind), version: version.toISOString() };
  }

  /**
   * How many rows carry each code (§5.19's `includeUsage`).
   *
   * Per kind, because a vocabulary is used by whatever uses it: an interest is on a profile, a
   * community category is on requests **and** offers, a profession is on listings. There is no
   * generic answer, and a generic guess — "count the rows that mention it" — is the kind of number
   * a staff member would deactivate a live category on the strength of.
   *
   * The kinds without an entry return 0 rather than a wrong count, and say so in the doc: what the
   * number is for is the warning before a deactivation, and a zero reads as "nothing I can see
   * uses this" which is exactly what it means here.
   */
  private async usageFor(kind: TaxonomyKind, codes: string[]): Promise<Map<string, number> | null> {
    if (!codes.length) return new Map();

    const counts = new Map<string, number>();
    const add = (code: string | null, total: number) => {
      if (!code) return;

      counts.set(code, (counts.get(code) ?? 0) + total);
    };
    const tally = async (
      rows: Promise<Array<{ code: string | null; total: number }>>,
    ): Promise<void> => {
      for (const row of await rows) add(row.code, Number(row.total));
    };
    // A JSON array column: `interests` and `languages` hold several codes per member, so the count
    // is "profiles holding this code" rather than a group by one column.
    const inJsonArray = async (column: 'interests' | 'languages'): Promise<void> => {
      const rows = await this.database.$queryRaw<Array<{ code: string; total: bigint }>>`
        SELECT code, COUNT(*) AS total
        FROM "user_profile", jsonb_array_elements_text(${Prisma.raw(`"${column}"`)}) AS code
        WHERE ${Prisma.raw(`"${column}"`)} IS NOT NULL
        GROUP BY 1
      `;

      for (const row of rows) add(row.code, Number(row.total));
    };

    switch (kind) {
      case TaxonomyKind.COMMUNITY_CATEGORY:
        await tally(
          this.database.communityRequest
            .groupBy({ by: ['categoryCode'], _count: { _all: true } })
            .then(rows => rows.map(r => ({ code: r.categoryCode, total: r._count._all }))),
        );
        await tally(
          this.database.communityOffer
            .groupBy({ by: ['categoryCode'], _count: { _all: true } })
            .then(rows => rows.map(r => ({ code: r.categoryCode, total: r._count._all }))),
        );
        break;
      case TaxonomyKind.GUIDE_TOPIC:
        await tally(
          this.database.guide
            .groupBy({ by: ['topicCode'], _count: { _all: true } })
            .then(rows => rows.map(r => ({ code: r.topicCode, total: r._count._all }))),
        );
        break;
      case TaxonomyKind.HERITAGE_TAG:
        await tally(
          this.database.userProfile
            .groupBy({ by: ['heritageTag'], _count: { _all: true } })
            .then(rows => rows.map(r => ({ code: r.heritageTag, total: r._count._all }))),
        );
        break;
      case TaxonomyKind.JOURNEY_STAGE:
        await tally(
          this.database.userProfile
            .groupBy({ by: ['journeyStage'], _count: { _all: true } })
            .then(rows => rows.map(r => ({ code: r.journeyStage, total: r._count._all }))),
        );
        break;
      case TaxonomyKind.COUNTRY_OF_ORIGIN:
        await tally(
          this.database.userProfile
            .groupBy({ by: ['countryOfOrigin'], _count: { _all: true } })
            .then(rows => rows.map(r => ({ code: r.countryOfOrigin, total: r._count._all }))),
        );
        break;
      case TaxonomyKind.CONNECTION_TYPE:
        await tally(
          this.database.connectProfile
            .groupBy({ by: ['typeCode'], _count: { _all: true } })
            .then(rows => rows.map(r => ({ code: r.typeCode, total: r._count._all }))),
        );
        break;
      case TaxonomyKind.ITEM_CATEGORY:
        await tally(
          this.database.storeItem
            .groupBy({ by: ['categoryCode'], _count: { _all: true } })
            .then(rows => rows.map(r => ({ code: r.categoryCode, total: r._count._all }))),
        );
        break;
      case TaxonomyKind.STORE_TYPE:
        await tally(
          this.database.store
            .groupBy({ by: ['typeCode'], _count: { _all: true } })
            .then(rows => rows.map(r => ({ code: r.typeCode, total: r._count._all }))),
        );
        break;
      case TaxonomyKind.GUARD_CATEGORY:
        await tally(
          this.database.guardThread
            .groupBy({ by: ['categoryCode'], _count: { _all: true } })
            .then(rows => rows.map(r => ({ code: r.categoryCode, total: r._count._all }))),
        );
        break;
      case TaxonomyKind.INTEREST:
        await inJsonArray('interests');
        break;
      case TaxonomyKind.LANGUAGE:
        await inJsonArray('languages');
        break;
      default:
        // PROFESSION and MANAGED_CATEGORY are join tables and the rest are seed-only; both return
        // zero rather than a number nobody could act on.
        break;
    }

    return counts;
  }

  async upsert(dto: UpsertTaxonomyTermDto) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(dto.code)) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'A code must be UPPER_SNAKE.',
        { details: [{ field: 'code', message: 'Use UPPER_SNAKE, e.g. AIRPORT_PICKUP.' }] },
      );
    }

    const before = await this.database.taxonomyTerm.findUnique({
      where: { kind_code: { kind: dto.kind, code: dto.code } },
      select: { label: true, sort: true, isActive: true },
    });

    // Audited (B18). A vocabulary term is the label on a filter, a chip and a category across the
    // whole platform, and renaming or retiring one changes what every member sees — the risk terms
    // beside this have been audited since they were built, and these were not.
    const { result: term } = await this.audit.mutate<TaxonomyTerm>(
      (saved: TaxonomyTerm) => ({
        action: 'taxonomy.upserted',
        targetType: 'TAXONOMY_TERM',
        targetId: saved.id,
        targetLabel: `${dto.kind}: ${dto.code}`,
        before: before ?? null,
        after: { label: saved.label, sort: saved.sort, isActive: saved.isActive },
      }),
      tx =>
        tx.taxonomyTerm.upsert({
          where: { kind_code: { kind: dto.kind, code: dto.code } },
          update: {
            label: dto.label,
            // **Changed only when sent.** `?? null` erased the description of any term saved
            // without one — and the screen that saves a label is not necessarily the screen that
            // has the description in front of it. An explicit empty string still clears it, which
            // is how a caller says "remove this".
            ...(dto.description === undefined ? {} : { description: dto.description || null }),
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
        }),
    );

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

    await this.audit.mutate(
      {
        action: 'taxonomy.deactivated',
        targetType: 'TAXONOMY_TERM',
        targetId: term.id,
        targetLabel: `${kind}: ${code}`,
        before: { isActive: term.isActive },
        after: { isActive: false },
      },
      tx => tx.taxonomyTerm.update({ where: { id: term.id }, data: { isActive: false } }),
    );

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
