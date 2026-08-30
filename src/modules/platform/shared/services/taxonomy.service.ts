import { Injectable } from '@nestjs/common';
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
@Injectable()
export class TaxonomyService {
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
   * Resolves whatever the client sent onto a real code: the code itself, a differently cased one,
   * or the human label from the picker. Returns null when nothing matches.
   *
   * The shipped app sends the label for some fields, so `countryOfOrigin: "Nigeria"` arrives where
   * `NG` is expected. Rejecting it would block onboarding on a value the member picked from a list
   * this API served them.
   */
  async resolveCode(kind: TaxonomyKind, value: string): Promise<string | null> {
    await this.ensureLoaded();

    const terms = this.cache.get(kind);

    if (!terms) return null;

    const trimmed = value.trim();

    if (terms.has(trimmed)) return trimmed;

    const normalise = (input: string) => input.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    const needle = normalise(trimmed);

    for (const term of terms.values()) {
      if (normalise(term.code) === needle || normalise(term.label) === needle) return term.code;
    }

    return null;
  }

  /** Rejects an unknown or deactivated code on write. */
  async assertValid(kind: TaxonomyKind, code: string, field: string): Promise<TermRecord> {
    const term = await this.get(kind, code);

    if (!term || !term.isActive) {
      throw ApiException.unprocessable(
        ApiErrorCode.UNKNOWN_TAXONOMY_CODE,
        `"${code}" is not a valid ${this.kindLabel(kind)}.`,
        { details: [{ field, message: `"${code}" is not a valid ${this.kindLabel(kind)}.` }] },
      );
    }

    return term;
  }

  async assertAllValid(kind: TaxonomyKind, codes: string[], field: string): Promise<TermRecord[]> {
    const terms: TermRecord[] = [];

    for (const code of codes) {
      terms.push(await this.assertValid(kind, code, field));
    }

    return terms;
  }

  /** Filters a list of codes down to the ones that exist, for a lenient query filter. */
  async knownCodes(kind: TaxonomyKind, codes: string[]): Promise<string[]> {
    await this.ensureLoaded();

    const known = this.cache.get(kind);

    return codes.filter(code => known?.has(code));
  }

  private kindLabel(kind: TaxonomyKind): string {
    return kind.toLowerCase().replace(/_/g, ' ');
  }
}
