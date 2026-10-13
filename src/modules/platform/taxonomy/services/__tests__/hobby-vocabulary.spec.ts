import { TaxonomyKind } from '@prisma/client';
import { taxonomySeeds } from '../../../../../../prisma/seeders/data/taxonomy';
import { SYSTEM_CONFIG_DEFAULTS, SYSTEM_CONFIG_KEYS } from '@/common';
import { TAXONOMY_LIMITS } from '../taxonomy-catalogue.service';

/**
 * `hobbies` is not `interests`, and in particular it is not `communityCategories`.
 *
 * The Connect profile asks "what you have in common with people" and used to answer it from the
 * interest list — whose first fifteen codes are community categories, because the feed ranker
 * matches a post's category against a member's interests. So the picker offered Airport Pickup,
 * Bank Account and Benefits & Support: things people need help with, not things they are into.
 *
 * Two vocabularies fix that, and one rule keeps them apart. This is that rule. The app has the
 * same test on its side, so a code reused in the seed fails on both.
 *
 * Sharing a code with `interests` is fine and intended — READING, MUSIC and TRAVEL mean the same
 * thing in both lists. It is the **category** overlap that made the picker nonsense.
 */
const codesOf = (kind: TaxonomyKind): string[] =>
  taxonomySeeds.filter(term => term.kind === kind).map(term => term.code);

describe('the hobby vocabulary', () => {
  const hobbies = codesOf(TaxonomyKind.HOBBY);
  const categories = new Set(codesOf(TaxonomyKind.COMMUNITY_CATEGORY));

  it('is seeded, which is the one thing a filtering test cannot report for itself', () => {
    expect(hobbies.length).toBe(52);
    expect(categories.size).toBeGreaterThan(20);
  });

  it('shares no code with the community categories', () => {
    expect(hobbies.filter(code => categories.has(code))).toEqual([]);
  });

  it('holds each code once', () => {
    expect([...new Set(hobbies)]).toHaveLength(hobbies.length);
  });

  it('gives every code a label and a code the client can key on', () => {
    for (const term of taxonomySeeds.filter(term => term.kind === TaxonomyKind.HOBBY)) {
      expect(term.code).toMatch(/^[A-Z][A-Z_]*$/);
      expect(term.label.trim().length).toBeGreaterThan(0);
    }
  });

  /**
   * The payload and the enforcement read the same number. A limit the client is shown and the
   * service does not read is a number that starts lying the moment somebody changes it.
   */
  it('publishes a cap that matches the configured default', () => {
    expect(TAXONOMY_LIMITS.maxHobbies).toBe(SYSTEM_CONFIG_DEFAULTS[SYSTEM_CONFIG_KEYS.MAX_HOBBIES]);
    expect(TAXONOMY_LIMITS.minConnectPhotos).toBe(
      SYSTEM_CONFIG_DEFAULTS[SYSTEM_CONFIG_KEYS.MIN_CONNECT_PHOTOS],
    );
    expect(TAXONOMY_LIMITS.minPromptAnswer).toBe(
      SYSTEM_CONFIG_DEFAULTS[SYSTEM_CONFIG_KEYS.MIN_PROMPT_ANSWER],
    );
    expect(TAXONOMY_LIMITS.maxPromptAnswer).toBe(
      SYSTEM_CONFIG_DEFAULTS[SYSTEM_CONFIG_KEYS.MAX_PROMPT_ANSWER],
    );
  });
});
