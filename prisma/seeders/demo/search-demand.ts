import { ActivitySubject, ActivityVerb, Prisma, SearchScope } from '@prisma/client';
import { DemoSeedContext, userId } from './seed-demo';
import { hoursAgo, SEED_TAG, seedId } from './ids';
import { connectExtras, PEOPLE } from './people';

/**
 * What members typed into each search box, so the published lists (6.3) have something in them
 * before anybody has searched for real.
 *
 * These are ordinary `ActivityEvent` rows — the same rows the live recorder writes — and not
 * snapshots. That matters for three reasons. The rebuild aggregates them beside real searches
 * rather than instead of them, so a genuine search for a seeded term raises its count instead of
 * competing with it. Every rule the published list applies — the five-member floor, the private
 * shapes, the four-stage resolution — is applied to this data too, so the demo cannot show a row
 * the real pipeline would have refused. And nothing here is privileged: once real demand outranks
 * it, it falls past the fifty-row cap on its own.
 */

/** Who did the searching, taken from the members we actually seeded in each city. */
const membersIn = (cityId: string): string[] =>
  [
    ...PEOPLE.filter(person => person.cityId === cityId).map(person => person.n),
    ...connectExtras()
      .filter(person => person.cityId === cityId)
      .map(person => person.n),
  ].map(userId);

/** The published list's own floor, repeated here so the seeder cannot promise what it cannot clear. */
const MEMBER_FLOOR = 5;

interface SeedTerm {
  scope: SearchScope;
  /** Exactly as a member would type it, fragments and all. */
  typed: string;
  /** How many different people typed it. Five is the floor; below that nothing is published. */
  members: number;
  /** Searches in the last seven days, and in the seven before that — `rising` reads both. */
  thisWeek: number;
  lastWeek: number;
  /** How many of this week's searches came back with nothing, which is what `unmet` ranks by. */
  misses: number;
}

/**
 * Manchester and London only: those are the two cities with enough seeded members to clear a floor
 * of five different people. Seeding Leeds from Manchester members would have put a number on a
 * city screen that no seeded member could have produced.
 *
 * `misses` is a claim about the catalogue and has to agree with it: a term seeded as unanswered
 * must be one nothing here answers, or the demo shows a seller a gap we already fill. Each one
 * below was checked against what the other seeders write.
 *
 * Both cities carry all five boxes. Seeded product demand in Manchester does land on the Add Item
 * composer's hint for every shop in the city, including one an end-to-end run has just created —
 * which is correct, because that hint is city-wide by design — so the suite that checks it was
 * given a city of its own rather than this data being bent around it.
 */
const DEMAND: Record<string, SeedTerm[]> = {
  MANCHESTER: [
    // A profession label, exactly.
    { scope: SearchScope.PROFESSIONALS, typed: 'immigration', members: 9, thisWeek: 34, lastWeek: 20, misses: 0 },
    // Flat week on week: in `top`, deliberately absent from `rising`.
    { scope: SearchScope.PROFESSIONALS, typed: 'handyman', members: 6, thisWeek: 15, lastWeek: 15, misses: 0 },
    // No listing answers it: the gap a professional joining could fill.
    { scope: SearchScope.PROFESSIONALS, typed: 'mortgage broker', members: 6, thisWeek: 17, lastWeek: 5, misses: 17 },
    // Resolves against something we hold — "Puna yam, whole", with its category, so the row is tappable.
    { scope: SearchScope.PRODUCTS, typed: 'puna yam', members: 7, thisWeek: 26, lastWeek: 10, misses: 0 },
    { scope: SearchScope.PRODUCTS, typed: 'red palm', members: 6, thisWeek: 18, lastWeek: 13, misses: 0 },
    // Nothing in any shop answers this, which is the whole point of the unmet list.
    { scope: SearchScope.PRODUCTS, typed: 'ogbono soup', members: 6, thisWeek: 15, lastWeek: 11, misses: 15 },
    // A two-letter fragment, the case the resolution stage exists for: it completes against a real
    // item — "Kohl liner" — and publishes under that name with its category. Nothing worked this
    // out; it is a prefix match on a column we already index.
    { scope: SearchScope.PRODUCTS, typed: 'ko', members: 6, thisWeek: 11, lastWeek: 4, misses: 0 },
    { scope: SearchScope.GUIDES, typed: 'bank account', members: 11, thisWeek: 41, lastWeek: 26, misses: 0 },
    // Nobody has written this one, which is the gap the unmet list exists to show a writer. Chosen
    // after checking it against the seeded guides: "council tax" was the obvious term and a guide
    // already answers it, so seeding misses against it would have invented a gap we fill.
    { scope: SearchScope.GUIDES, typed: 'childcare vouchers', members: 7, thisWeek: 20, lastWeek: 6, misses: 20 },
    // Falling, so it sits in `top` and not in `rising`.
    { scope: SearchScope.GUIDES, typed: 'housing', members: 7, thisWeek: 18, lastWeek: 23, misses: 0 },
    { scope: SearchScope.REQUESTS, typed: 'airport pickup', members: 8, thisWeek: 27, lastWeek: 9, misses: 0 },
    { scope: SearchScope.REQUESTS, typed: 'moving help', members: 6, thisWeek: 14, lastWeek: 8, misses: 5 },
    { scope: SearchScope.COMMUNITY, typed: 'make friends', members: 10, thisWeek: 29, lastWeek: 21, misses: 0 },
    // No taxonomy label and no content behind it, so it publishes as typed — which is right: it is
    // a whole thought, and a group that does not exist yet is demand worth showing.
    { scope: SearchScope.COMMUNITY, typed: 'nigerian mums manchester', members: 6, thisWeek: 13, lastWeek: 0, misses: 13 },

    // ── The two below are seeded to be refused, so the rules are visible rather than claimed ──
    // Carries a digit, so it is somebody's own business whatever the counts say.
    { scope: SearchScope.PROFESSIONALS, typed: 'tier 2 sponsor lawyer', members: 6, thisWeek: 12, lastWeek: 3, misses: 12 },
    // Two people. Rare enough to identify whoever typed it, so the floor keeps it off the screen.
    { scope: SearchScope.PROFESSIONALS, typed: 'solicitor for an asylum appeal', members: 2, thisWeek: 4, lastWeek: 1, misses: 4 },
  ],
  LONDON: [
    // Resolves against something we hold — "Puna yam, whole", with its category, so the row is tappable.
    { scope: SearchScope.PRODUCTS, typed: 'puna yam', members: 8, thisWeek: 31, lastWeek: 12, misses: 0 },
    { scope: SearchScope.PRODUCTS, typed: 'red palm', members: 6, thisWeek: 19, lastWeek: 14, misses: 0 },
    // Nothing in any shop answers these, which is the whole point of the unmet list.
    { scope: SearchScope.PRODUCTS, typed: 'suya spice', members: 7, thisWeek: 24, lastWeek: 6, misses: 24 },
    { scope: SearchScope.PRODUCTS, typed: 'ogbono soup', members: 6, thisWeek: 15, lastWeek: 11, misses: 15 },
    // A two-letter fragment, which is the case the whole resolution stage exists for: it completes
    // against a real item — "Kohl liner" — and publishes under that name with its category, so the
    // row is tappable. Nothing worked this out; it is a prefix match on a column we already index.
    { scope: SearchScope.PRODUCTS, typed: 'ko', members: 6, thisWeek: 11, lastWeek: 4, misses: 0 },
    { scope: SearchScope.PRODUCTS, typed: 'ankara', members: 9, thisWeek: 33, lastWeek: 11, misses: 0 },
    { scope: SearchScope.PRODUCTS, typed: 'henna', members: 6, thisWeek: 16, lastWeek: 12, misses: 0 },
    { scope: SearchScope.PRODUCTS, typed: 'whiting fish', members: 8, thisWeek: 26, lastWeek: 7, misses: 26 },
    { scope: SearchScope.PROFESSIONALS, typed: 'translation', members: 7, thisWeek: 21, lastWeek: 13, misses: 0 },
    { scope: SearchScope.PROFESSIONALS, typed: 'childcare', members: 6, thisWeek: 17, lastWeek: 17, misses: 0 },
    { scope: SearchScope.PROFESSIONALS, typed: 'dentist', members: 7, thisWeek: 19, lastWeek: 6, misses: 19 },
    { scope: SearchScope.GUIDES, typed: 'visa', members: 12, thisWeek: 44, lastWeek: 25, misses: 0 },
    { scope: SearchScope.GUIDES, typed: 'reading a tenancy', members: 6, thisWeek: 12, lastWeek: 4, misses: 0 },
    { scope: SearchScope.GUIDES, typed: 'driving licence exchange', members: 6, thisWeek: 15, lastWeek: 4, misses: 15 },
    { scope: SearchScope.REQUESTS, typed: 'accommodation', members: 10, thisWeek: 31, lastWeek: 22, misses: 9 },
    { scope: SearchScope.REQUESTS, typed: 'beauty', members: 6, thisWeek: 13, lastWeek: 10, misses: 0 },
    { scope: SearchScope.COMMUNITY, typed: 'language help', members: 8, thisWeek: 23, lastWeek: 10, misses: 0 },
    { scope: SearchScope.COMMUNITY, typed: 'somali community london', members: 7, thisWeek: 19, lastWeek: 0, misses: 19 },

    // The other half of the fragment rule: nothing in the catalogue or the vocabulary starts with
    // this, so it stays JUNK and is never published. It is retried every run, and the day somebody
    // lists akara it stops being junk on its own.
    { scope: SearchScope.PRODUCTS, typed: 'ak', members: 6, thisWeek: 10, lastWeek: 2, misses: 10 },
    // Refused: a digit.
    { scope: SearchScope.REQUESTS, typed: 'flat 2 bed shepherds bush', members: 6, thisWeek: 14, lastWeek: 5, misses: 14 },
  ],
};

/** Spread across the window rather than stacked, so nothing reads as one burst. */
const spread = (index: number, total: number, from: number, span: number): Date =>
  hoursAgo(from + Math.floor((index * span) / Math.max(total, 1)));

export const seedSearchDemand = async (ctx: DemoSeedContext) => {
  const { prisma } = ctx;

  // The row ids are derived from city, scope and term, so the same triple twice is the same id
  // twice. Said here, where the term can be named, rather than as a unique-constraint error from
  // inside a bulk insert that cannot say which one it was.
  for (const [cityId, terms] of Object.entries(DEMAND)) {
    const seen = new Set<string>();

    for (const term of terms) {
      const key = `${term.scope}:${term.typed}`;

      if (seen.has(key)) {
        throw new Error(`Search demand seed lists ${cityId} ${term.scope} "${term.typed}" twice.`);
      }

      seen.add(key);
    }
  }

  // Everything this seeder owns is cleared first, and then written back from the table above, so
  // the table is the whole truth about the demo's search history. An earlier version only withdrew
  // terms it had stopped declaring, which left a term that merely MOVED CITY recorded in both — and
  // the published list went on reporting demand from a city the table no longer claimed.
  //
  // Scoped by the tag, so only rows this seeder wrote are ever removed. A real member's search for
  // the same words is untagged and survives, which is what keeps the two kinds of data separate:
  // real searches accumulate beside these and are never replaced by them.
  const withdrawn = await prisma.activityEvent.deleteMany({
    where: {
      subject: ActivitySubject.SEARCH_TERM,
      metadata: { path: ['seed'], equals: SEED_TAG },
    },
  });

  const rows: Prisma.ActivityEventCreateManyInput[] = [];

  for (const [cityId, terms] of Object.entries(DEMAND)) {
    const pool = membersIn(cityId);

    // Below the floor there is nobody to attribute the searches to, and inventing members to carry
    // them would put a number on a city screen no seeded member could have produced.
    if (pool.length < MEMBER_FLOOR) continue;

    for (const term of terms) {
      // The two windows the rebuild reads: the last seven days, and the seven before them.
      const windows = [
        { label: 'this', count: term.thisWeek, misses: term.misses, from: 3, span: 160 },
        {
          label: 'last',
          count: term.lastWeek,
          // Kept in proportion. Never read by the job — `rising` only compares volumes — but a raw
          // query against the stream should not see a term that missed every time this week and
          // never missed before.
          misses: Math.round((term.misses / Math.max(term.thisWeek, 1)) * term.lastWeek),
          from: 172,
          span: 156,
        },
      ];

      for (const window of windows) {
        for (let index = 0; index < window.count; index += 1) {
          rows.push({
            id: seedId(
              `search-demand:${cityId}:${term.scope}:${term.typed}:${window.label}:${index}`,
            ),
            // Cycled over exactly as many members as the row claims, because the floor counts
            // people and not searches.
            userId: pool[index % Math.min(term.members, pool.length)],
            verb: ActivityVerb.SEARCH,
            subject: ActivitySubject.SEARCH_TERM,
            scope: term.scope,
            cityId,
            term: term.typed,
            hadResults: index >= window.misses,
            // Relative to the run: a reseed months later has to put the demo back inside the
            // window it is read through.
            occurredAt: spread(index, window.count, window.from, window.span),
            // How a row is known to be ours, which is what makes the clearing above safe.
            metadata: { seed: SEED_TAG },
          });
        }
      }
    }
  }

  await prisma.activityEvent.createMany({ data: rows });

  const terms = Object.values(DEMAND).reduce((total, list) => total + list.length, 0);

  return { events: rows.length, terms, withdrawn: withdrawn.count, cities: Object.keys(DEMAND).length };
};
