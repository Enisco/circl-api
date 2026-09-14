import { Injectable, Logger } from '@nestjs/common';
import { TaxonomyKind, TaxonomyTerm } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException } from '@/common';

export interface TermRecord {
  code: string;
  label: string;
  description: string | null;
  sort: number;
  isActive: boolean;
  metadata: Record<string, unknown> | null;
}

/** Reads the taxonomy and validates codes against it. */
/** Punctuation and case are not the difference between two codes: "Mid-level" and MID_LEVEL match. */
const normalise = (input: string) =>
  input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

/** Code or label, compared the way `resolveCode` compares them. */
const matches = (term: TermRecord, value: string): boolean =>
  normalise(term.code) === normalise(value) || normalise(term.label) === normalise(value);

@Injectable()
export class TaxonomyService {
  private readonly logger = new Logger(TaxonomyService.name);
  private cache = new Map<TaxonomyKind, Map<string, TermRecord>>();
  private cachedVersion: string | null = null;
  private cacheLoadedAt = 0;

  /** How long a process trusts its cache before re-checking the version stamp. */
  private static readonly CHECK_INTERVAL_MS = 30_000;

  constructor(private readonly database: PrismaService) {}

  async version(): Promise<Date> {
    const row = await this.database.taxonomyVersion.findUnique({ where: { id: 'SINGLETON' } });

    return row?.version ?? new Date(0);
  }

  /** Bumped by every admin write, which is what invalidates every process's cache. */
  async bumpVersion(): Promise<Date> {
    const row = await this.database.taxonomyVersion.upsert({
      where: { id: 'SINGLETON' },
      update: { version: new Date() },
      create: { id: 'SINGLETON', version: new Date() },
    });

    this.cache.clear();
    this.cachedVersion = null;

    return row.version;
  }

  private async ensureLoaded(): Promise<void> {
    const now = Date.now();

    if (this.cache.size > 0 && now - this.cacheLoadedAt < TaxonomyService.CHECK_INTERVAL_MS) {
      return;
    }

    const version = (await this.version()).toISOString();

    if (this.cache.size > 0 && version === this.cachedVersion) {
      this.cacheLoadedAt = now;

      return;
    }

    const terms = await this.database.taxonomyTerm.findMany({ orderBy: { sort: 'asc' } });
    const next = new Map<TaxonomyKind, Map<string, TermRecord>>();

    for (const term of terms) {
      if (!next.has(term.kind)) next.set(term.kind, new Map());
      next.get(term.kind)!.set(term.code, this.toRecord(term));
    }

    this.cache = next;
    this.cachedVersion = version;
    this.cacheLoadedAt = now;
  }

  private toRecord(term: TaxonomyTerm): TermRecord {
    return {
      code: term.code,
      label: term.label,
      description: term.description,
      sort: term.sort,
      isActive: term.isActive,
      metadata: (term.metadata as Record<string, unknown> | null) ?? null,
    };
  }

  /** Every term of a kind, active first is not implied — order is by `sort`. */
  async list(kind: TaxonomyKind, activeOnly = true): Promise<TermRecord[]> {
    await this.ensureLoaded();

    const terms = [...(this.cache.get(kind)?.values() ?? [])];

    return (activeOnly ? terms.filter(term => term.isActive) : terms).sort(
      (a, b) => a.sort - b.sort,
    );
  }

  async get(kind: TaxonomyKind, code: string): Promise<TermRecord | null> {
    await this.ensureLoaded();

    return this.cache.get(kind)?.get(code) ?? null;
  }

  /** A `code -> label` map, for serialising a page of rows without N lookups. */
  async labels(kind: TaxonomyKind): Promise<Map<string, string>> {
    await this.ensureLoaded();

    const map = new Map<string, string>();

    for (const term of this.cache.get(kind)?.values() ?? []) {
      map.set(term.code, term.label);
    }

    return map;
  }

  /**
   * Resolves a code, a differently cased code, or the picker's label onto a real code; null when
   * nothing matches. The shipped app sends labels, and rejecting them would block onboarding.
   */
  async resolveCode(kind: TaxonomyKind, value: string): Promise<string | null> {
    await this.ensureLoaded();

    const terms = this.cache.get(kind);

    if (!terms) return null;

    const trimmed = value.trim();

    if (terms.has(trimmed)) return trimmed;

    for (const term of terms.values()) {
      if (matches(term, trimmed)) return term.code;
    }

    return null;
  }

  /**
   * Rejects an unknown code, and a retired one the member does not already hold.
   *
   * `held` is what they have now. A retired term stays writable by whoever already carries it,
   * because the alternative traps them: the form hands the value back, the member edits something
   * else entirely, and the save is refused over a field they never touched and a term the picker
   * no longer offers. Nobody new can pick it, which is the whole point of retiring it.
   */
  async assertValid(
    kind: TaxonomyKind,
    code: string,
    field: string,
    held?: ReadonlySet<string>,
  ): Promise<TermRecord> {
    const term = await this.get(kind, code);

    if (!term) {
      const message = `"${code}" is not a valid ${this.kindLabel(kind)}.${this.livesIn(kind, code)}`;

      throw ApiException.unprocessable(ApiErrorCode.UNKNOWN_TAXONOMY_CODE, message, {
        details: [{ field, message }],
      });
    }

    if (!term.isActive && !held?.has(code)) {
      const message = `"${code}" is no longer offered as a ${this.kindLabel(kind)}.`;

      throw ApiException.unprocessable(ApiErrorCode.UNKNOWN_TAXONOMY_CODE, message, {
        details: [{ field, message }],
      });
    }

    return term;
  }

  /**
   * Where the value actually belongs, when it belongs somewhere. A picker filled from the wrong
   * list sends a perfectly real code and gets told only that it is not valid here, which is true
   * and useless. Naming the vocabulary it came from turns the refusal into the fix.
   */
  private livesIn(kind: TaxonomyKind, code: string): string {
    const homes = [...this.cache.entries()]
      .filter(([other]) => other !== kind)
      .filter(([, terms]) => [...terms.values()].some(term => matches(term, code)))
      .map(([other]) => this.kindLabel(other));

    if (!homes.length) return '';

    return ` That is a ${homes.join(' and a ')} — the picker is reading the wrong list.`;
  }

  async assertAllValid(
    kind: TaxonomyKind,
    codes: string[],
    field: string,
    held?: ReadonlySet<string>,
  ): Promise<TermRecord[]> {
    const terms: TermRecord[] = [];

    for (const code of codes) {
      terms.push(await this.assertValid(kind, code, field, held));
    }

    return terms;
  }

  /** Filters a list of codes down to the ones that exist, for a lenient query filter. */
  async knownCodes(kind: TaxonomyKind, codes: string[], source?: string): Promise<string[]> {
    await this.ensureLoaded();

    const known = this.cache.get(kind);
    const recognised = codes.filter(code => known?.has(code));

    if (recognised.length !== codes.length) {
      this.noteUnknown(
        kind,
        codes.filter(code => !known?.has(code)),
        source,
      );
    }

    return recognised;
  }

  /**
   * Says so when a filter arrives carrying something that is not in the vocabulary, without
   * refusing it.
   *
   * A browse filter takes an unknown code as a filter that matches nothing, so a client sending a
   * display label where a code belongs gets an empty screen and no error — which is how the
   * marketplace shipped for months with every category chip returning nothing. Refusing it outright
   * is the eventual answer; until the client has moved every picker over, this is how both sides
   * can see which screens are still sending labels rather than working through them from memory.
   */
  async noteUnknownCodes(kind: TaxonomyKind, codes: string[], source: string): Promise<void> {
    if (!codes.length) return;

    await this.ensureLoaded();

    const known = this.cache.get(kind);
    const unknown = codes.filter(code => !known?.has(code));

    this.noteUnknown(kind, unknown, source);
  }

  private noteUnknown(kind: TaxonomyKind, unknown: string[], source?: string): void {
    if (!unknown.length) return;

    this.logger.warn(
      `Unknown ${kind} code${unknown.length > 1 ? 's' : ''} on ${source ?? 'a filter'}: ` +
        unknown.map(code => JSON.stringify(code)).join(', ') +
        ' — the filter matched nothing and said nothing.',
    );
  }

  private kindLabel(kind: TaxonomyKind): string {
    return kind.toLowerCase().replace(/_/g, ' ');
  }
}
