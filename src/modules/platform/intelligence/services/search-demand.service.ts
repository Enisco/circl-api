import { Injectable, Logger } from '@nestjs/common';
import { ActivitySubject, ActivityVerb, Prisma, SearchScope, SearchTermSource, TaxonomyKind } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { TaxonomyService } from '../../shared';

/** The published list and the filters above it. `ALL` is the union of the five. */
export const SEARCH_FILTERS = ['ALL', ...Object.values(SearchScope)] as const;
export type SearchFilter = (typeof SEARCH_FILTERS)[number];

/** Which depths the member may choose (the spec's top 10, 20, 50). */
export const SEARCH_DEPTHS = [10, 20, 50] as const;

const SECTION = 'SEARCH_DEMAND';

/**
 * How many **different people** must have searched a term before it is published.
 *
 * Not how many searches: one anxious person typing the same thing five times would clear a search
 * floor, and "immigration solicitor for my asylum appeal" searched once is identifying even with
 * no name attached to it. The spec says queries are counted and not attributed; rarity is the part
 * attribution rules do not cover, and this is the defence against it.
 */
const MEMBER_FLOOR = 5;

/** Below this a term is a keystroke on the way to a word, not a thing somebody wanted. */
const MIN_TERM_LENGTH = 2;

/** Anything holding one of these is somebody's own business, whatever the counts say. */
const PRIVATE_SHAPES = [/\d/, /@/, /\+\d/, /https?:/];

interface TermRow {
  normalised: string;
  scope: SearchScope;
  searches: number;
  members: number;
  misses: number;
}

@Injectable()
export class SearchDemandService {
  private readonly logger = new Logger(SearchDemandService.name);

  constructor(
    private readonly database: PrismaService,
    private readonly taxonomy: TaxonomyService,
  ) {}

  // ─── Reading ───────────────────────────────────────────────────────────────

  /**
   * The published lists. Read straight off the snapshots, so the endpoint is one indexed query
   * however much was searched — and every list carries when it was last built, because the spec
   * asks that no number sit without a date.
   */
  async published(filter: SearchFilter, cityId: string | null, limit: number) {
    const depth = SEARCH_DEPTHS.includes(limit as 10) ? limit : SEARCH_DEPTHS[0];

    const rows = await this.database.metricSnapshot.findMany({
      where: {
        section: SECTION,
        // Empty string, not null: that is how the snapshot table spells "nationwide", because the
        // unique key cannot be partly null. Reading it as null returned nothing for the one list
        // most members open first.
        cityId: cityId ?? '',
        metric: { startsWith: `${filter}.` },
      },
    });

    const of = (kind: string) =>
      (rows.find(row => row.metric === `${filter}.${kind}`)?.items as unknown as Array<
        Record<string, unknown>
      > | null) ?? [];

    return {
      filter,
      cityId: cityId ?? null,
      limit: depth,
      /** What people searched for, most first. */
      top: of('top').slice(0, depth),
      /** What they searched for and found nothing — the gap a new seller or writer can fill. */
      unmet: of('unmet').slice(0, depth),
      /** Rising fastest against the week before, so a trend is visible before it is obvious. */
      rising: of('rising').slice(0, depth),
      window: rows[0]
        ? { start: rows[0].windowStart.toISOString(), end: rows[0].windowEnd.toISOString() }
        : null,
      updatedAt: rows[0]?.computedAt.toISOString() ?? null,
    };
  }

  // ─── Rebuilding ────────────────────────────────────────────────────────────

  /**
   * Scheduled, never per-search. Nobody needs this leaderboard to move within the minute, the
   * windows the spec asks for are a week and a month, and resolving the same fragment on every
   * keystroke would be work done thousands of times for one answer.
   */
  async rebuild(): Promise<number> {
    const now = new Date();
    const weekStart = new Date(now.getTime() - 7 * 86_400_000);
    const priorStart = new Date(now.getTime() - 14 * 86_400_000);

    const [current, prior] = await Promise.all([
      this.aggregate(weekStart, now),
      this.aggregate(priorStart, weekStart),
    ]);

    await this.resolveUnknown([...current, ...prior]);

    const dictionary = await this.dictionary();
    const cities = [null, ...new Set(current.map(row => row.cityId).filter(Boolean))];
    let written = 0;

    for (const cityId of cities) {
      for (const filter of SEARCH_FILTERS) {
        written += await this.writeFor(
          filter,
          cityId as string | null,
          current,
          prior,
          dictionary,
          weekStart,
          now,
        );
      }
    }

    // Anything this run did not rewrite is a list whose searches have all aged out of the window
    // — a city that went quiet, or a filter nobody used since. Every snapshot written above
    // carries this run's `weekStart`, so an older one is by definition stale, and a stale
    // leaderboard presented as this week's is worse than an empty one.
    const stale = await this.database.metricSnapshot.deleteMany({
      where: { section: SECTION, windowStart: { lt: weekStart } },
    });

    this.logger.log(
      `Search demand rebuilt: ${written} snapshots` +
        (stale.count ? `, ${stale.count} stale removed` : ''),
    );

    return written;
  }

  /**
   * One grouped query over the window rather than a row-by-row read. Fifty thousand searches
   * collapse to a few hundred distinct terms here, which is what makes everything after this
   * cheap — nothing downstream ever reasons about a search, only about a term.
   */
  private async aggregate(from: Date, to: Date): Promise<Array<TermRow & { cityId: string | null }>> {
    return this.database.$queryRaw<Array<TermRow & { cityId: string | null }>>`
      SELECT
        lower(btrim(regexp_replace(term, '[^[:alnum:][:space:]]', '', 'g'))) AS normalised,
        scope,
        city_id AS "cityId",
        COUNT(*)::int AS searches,
        COUNT(DISTINCT user_id)::int AS members,
        COUNT(*) FILTER (WHERE had_results = false)::int AS misses
      FROM activity_events
      WHERE subject = ${ActivitySubject.SEARCH_TERM}::"ActivitySubject"
        AND verb = ${ActivityVerb.SEARCH}::"ActivityVerb"
        AND scope IS NOT NULL
        AND term IS NOT NULL
        AND occurred_at >= ${from}
        AND occurred_at < ${to}
      GROUP BY 1, 2, 3
      HAVING length(lower(btrim(regexp_replace(term, '[^[:alnum:][:space:]]', '', 'g')))) >= ${MIN_TERM_LENGTH}
    `;
  }

  /**
   * What a typed fragment meant, worked out once and remembered.
   *
   * Four stages, cheapest first, and no model in any of them: the words members reach for are
   * already in our own taxonomy and in the names of the things we hold, and those columns are
   * already trigram-indexed. A term that survives all four is published as typed when it is whole
   * enough and dropped when it is not — showing a guess is worse than showing a shorter list.
   */
  private async resolveUnknown(rows: Array<TermRow>): Promise<void> {
    const pairs = new Map<string, { normalised: string; scope: SearchScope }>();

    for (const row of rows) {
      if (!row.normalised) continue;

      pairs.set(`${row.scope}:${row.normalised}`, { normalised: row.normalised, scope: row.scope });
    }

    if (!pairs.size) return;

    const known = await this.database.searchTermCanonical.findMany({
      where: { OR: [...pairs.values()] },
      select: { normalised: true, scope: true, source: true },
    });

    // A settled answer is never recomputed — that is the whole point of the dictionary. But the
    // two weak verdicts are tried again every run, because they depend on what the platform held
    // at the time: "ol" is junk until somebody lists olive oil, and then it is not. Without this
    // the first week's verdict would outlive the reason for it.
    const retry = new Set<SearchTermSource>([SearchTermSource.JUNK, SearchTermSource.RAW]);

    for (const row of known) {
      if (retry.has(row.source)) continue;

      pairs.delete(`${row.scope}:${row.normalised}`);
    }

    if (!pairs.size) return;

    const labels = await this.taxonomyLabels();

    for (const { normalised, scope } of pairs.values()) {
      const resolved =
        this.fromTaxonomy(normalised, scope, labels) ?? (await this.fromContent(normalised, scope));

      const verdict = {
        // As typed, but with the first letter raised: the normalised form is lowercase, and a list
        // mixing "suya spice" with "Immigration Advice" reads like a bug. Sentence case is a
        // display decision and not a claim about what the words mean, which is the line a guess
        // would cross.
        canonical:
          resolved?.canonical ?? normalised.charAt(0).toUpperCase() + normalised.slice(1),
        categoryCode: resolved?.code ?? null,
        // Whole enough to stand on its own, or not worth showing anybody. A fragment is not a
        // word: showing one is worse than showing a shorter list.
        source:
          resolved?.source ??
          (normalised.length >= 6 || normalised.includes(' ')
            ? SearchTermSource.RAW
            : SearchTermSource.JUNK),
      };

      await this.database.searchTermCanonical.upsert({
        where: { normalised_scope: { normalised, scope } },
        update: { ...verdict, resolvedAt: new Date() },
        create: { normalised, scope, ...verdict },
      });
    }
  }

  /**
   * Which code lists each search box actually filters on, most specific first.
   *
   * Ordered per scope rather than searched as one flat list, because the published `code` is what
   * a tap re-runs the search with. Read flat, "childcare" typed into Requests came back with the
   * profession code, and tapping it would have filtered requests by a code that is not a community
   * category at all. The last two are in every scope because heritage and language are filters on
   * more than one box.
   */
  private static readonly KINDS_FOR: Record<SearchScope, TaxonomyKind[]> = {
    [SearchScope.PRODUCTS]: [TaxonomyKind.ITEM_CATEGORY, TaxonomyKind.ITEM_UNIT],
    [SearchScope.PROFESSIONALS]: [TaxonomyKind.PROFESSION],
    [SearchScope.GUIDES]: [TaxonomyKind.GUIDE_TOPIC],
    [SearchScope.REQUESTS]: [TaxonomyKind.COMMUNITY_CATEGORY],
    [SearchScope.COMMUNITY]: [TaxonomyKind.COMMUNITY_CATEGORY, TaxonomyKind.INTEREST],
  };

  private static readonly SHARED_KINDS = [TaxonomyKind.HERITAGE_TAG, TaxonomyKind.LANGUAGE];

  /** Every code list whose labels are words a member might type, kept apart by kind. */
  private async taxonomyLabels(): Promise<Map<TaxonomyKind, Array<{ code: string; label: string }>>> {
    const kinds = [
      ...new Set([
        ...Object.values(SearchDemandService.KINDS_FOR).flat(),
        ...SearchDemandService.SHARED_KINDS,
      ]),
    ];
    const lists = await Promise.all(kinds.map(kind => this.taxonomy.list(kind, false)));

    return new Map(
      kinds.map((kind, index) => [
        kind,
        lists[index].map(term => ({ code: term.code, label: term.label })),
      ]),
    );
  }

  /** An exact or prefix match on a label this box already filters by, one pass over a small list. */
  private fromTaxonomy(
    normalised: string,
    scope: SearchScope,
    byKind: Map<TaxonomyKind, Array<{ code: string; label: string }>>,
  ): { canonical: string; code: string | null; source: SearchTermSource } | null {
    const labels = [
      ...SearchDemandService.KINDS_FOR[scope],
      ...SearchDemandService.SHARED_KINDS,
    ].flatMap(kind => byKind.get(kind) ?? []);

    const exact = labels.find(row => row.label.toLowerCase() === normalised);

    if (exact) {
      return { canonical: exact.label, code: exact.code, source: SearchTermSource.TAXONOMY };
    }

    // A fragment only completes against a label when it is long enough to mean something: "o"
    // prefixes half the vocabulary, and "immigr" prefixes one thing.
    if (normalised.length < 4) return null;

    const prefix = labels.find(row => row.label.toLowerCase().startsWith(normalised));

    return prefix
      ? { canonical: prefix.label, code: prefix.code, source: SearchTermSource.TAXONOMY }
      : null;
  }

  /**
   * The name of something we actually hold. This is the stage that does the work a model was
   * going to be asked for: somebody typing "ol" toward olive oil is reaching for a product that
   * already exists, and the trigram indexes on these columns were built for exactly this shape of
   * lookup.
   */
  private async fromContent(
    normalised: string,
    scope: SearchScope,
  ): Promise<{ canonical: string; code: string | null; source: SearchTermSource } | null> {
    if (normalised.length < 2) return null;

    const like = `${normalised.replace(/[%_\\]/g, char => `\\${char}`)}%`;

    const rows =
      scope === SearchScope.PRODUCTS
        ? await this.database.$queryRaw<Array<{ canonical: string; code: string | null }>>`
            SELECT name AS canonical, category_code AS code FROM store_items
            WHERE deleted_at IS NULL AND name ILIKE ${like}
            ORDER BY view_count DESC LIMIT 1`
        : scope === SearchScope.PROFESSIONALS
          ? await this.database.$queryRaw<Array<{ canonical: string; code: string | null }>>`
            SELECT profession_title AS canonical, NULL AS code FROM professional_listings
            WHERE deleted_at IS NULL AND profession_title ILIKE ${like}
            ORDER BY profile_views DESC LIMIT 1`
          : scope === SearchScope.GUIDES
            ? await this.database.$queryRaw<Array<{ canonical: string; code: string | null }>>`
            SELECT title AS canonical, topic_code AS code FROM guides
            WHERE deleted_at IS NULL AND title ILIKE ${like}
            ORDER BY view_count DESC LIMIT 1`
            : scope === SearchScope.REQUESTS
              ? await this.database.$queryRaw<Array<{ canonical: string; code: string | null }>>`
            SELECT title AS canonical, category_code AS code FROM community_requests
            WHERE deleted_at IS NULL AND title ILIKE ${like}
            ORDER BY created_at DESC LIMIT 1`
              // Offers and groups, because those are what the Community box searches. It used to
              // fall through to requests here, which answered a search of one surface with the
              // name of something on another.
              : await this.database.$queryRaw<Array<{ canonical: string; code: string | null }>>`
            SELECT canonical, code FROM (
              SELECT title AS canonical, category_code AS code, view_count AS rank
                FROM community_offers WHERE deleted_at IS NULL AND title ILIKE ${like}
              UNION ALL
              SELECT name AS canonical, category_code AS code, member_count AS rank
                FROM groups WHERE deleted_at IS NULL AND name ILIKE ${like}
            ) matches ORDER BY rank DESC LIMIT 1`;

    const hit = rows[0];

    return hit?.canonical
      ? { canonical: hit.canonical, code: hit.code, source: SearchTermSource.CONTENT }
      : null;
  }

  private async dictionary(): Promise<
    Map<string, { canonical: string; code: string | null; source: SearchTermSource }>
  > {
    const rows = await this.database.searchTermCanonical.findMany();

    return new Map(
      rows.map(
        row =>
          [
            `${row.scope}:${row.normalised}`,
            { canonical: row.canonical, code: row.categoryCode, source: row.source },
          ] as const,
      ),
    );
  }

  /**
   * One scope, one city, three lists. Terms are folded onto their canonical form first, so the
   * four rows somebody typed on the way to "olive oil" are counted as the one thing they wanted.
   */
  private async writeFor(
    filter: SearchFilter,
    cityId: string | null,
    current: Array<TermRow & { cityId: string | null }>,
    prior: Array<TermRow & { cityId: string | null }>,
    dictionary: Map<string, { canonical: string; code: string | null; source: SearchTermSource }>,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<number> {
    const fold = (rows: Array<TermRow & { cityId: string | null }>) => {
      const out = new Map<
        string,
        { canonical: string; code: string | null; searches: number; members: Set<number>; misses: number }
      >();

      for (const row of rows) {
        if (filter !== 'ALL' && row.scope !== filter) continue;
        if (cityId && row.cityId !== cityId) continue;

        const entry = dictionary.get(`${row.scope}:${row.normalised}`);

        if (!entry || entry.source === SearchTermSource.JUNK) continue;
        if (PRIVATE_SHAPES.some(shape => shape.test(entry.canonical))) continue;

        const key = entry.canonical.toLowerCase();
        const seen =
          out.get(key) ??
          { canonical: entry.canonical, code: entry.code, searches: 0, members: new Set<number>(), misses: 0 };

        seen.searches += row.searches;
        seen.misses += row.misses;
        // Distinct members cannot be summed across rows, so the count is carried and the floor is
        // applied to the largest single reading rather than to a total that would overstate it.
        seen.members.add(row.members);
        out.set(key, seen);
      }

      return out;
    };

    const currentFolded = fold(current);
    const priorFolded = fold(prior);

    const items = [...currentFolded.values()]
      .map(row => ({
        term: row.canonical,
        code: row.code,
        searches: row.searches,
        misses: row.misses,
        members: Math.max(...row.members, 0),
      }))
      .filter(row => row.members >= MEMBER_FLOOR);

    const top = [...items].sort((a, b) => b.searches - a.searches);
    // `searches` stays the real total and `misses` is what this list is ranked by. The two used to
    // be collapsed into one field here, which left a row in this list reporting a `searches` count
    // that was not the number of searches.
    const unmet = items.filter(row => row.misses > 0).sort((a, b) => b.misses - a.misses);
    const rising = items
      .map(row => {
        const before = priorFolded.get(row.term.toLowerCase())?.searches ?? 0;

        return { ...row, before, growth: before === 0 ? row.searches : row.searches / before };
      })
      // New this week counts as rising; one search against none is not a trend.
      .filter(row => row.searches >= MEMBER_FLOOR && row.growth > 1)
      .sort((a, b) => b.growth - a.growth);

    const write = async (kind: string, rows: unknown[]) => {
      const where = {
        section_metric_cityId_period: {
          section: SECTION,
          metric: `${filter}.${kind}`,
          cityId: cityId ?? '',
          period: 'WEEK',
        },
      };
      const data = {
        items: rows as Prisma.InputJsonValue,
        windowStart,
        windowEnd,
        computedAt: new Date(),
      };

      await this.database.metricSnapshot.upsert({
        where,
        update: data,
        create: {
          section: SECTION,
          metric: `${filter}.${kind}`,
          cityId: cityId ?? '',
          period: 'WEEK',
          ...data,
        },
      });
    };

    await Promise.all([
      write('top', top.slice(0, 50)),
      write('unmet', unmet.slice(0, 50)),
      write('rising', rising.slice(0, 50)),
    ]);

    return 3;
  }
}
