import { ContentVisibilityState } from '@prisma/client';
import {
  DIRECT_VISIBILITY,
  PUBLIC_VISIBILITY,
  REVIEW_MESSAGE,
  directVisibilitySql,
  isPublic,
  isReachable,
  publicVisibilitySql,
  reviewStatusOf,
} from '../content-visibility';

/**
 * The five states, and what each one means on the three surfaces that ask.
 *
 * Written as a table over `ContentVisibilityState` itself, so adding a sixth state fails here
 * rather than quietly inheriting whatever the `default:` branch does. That matters more than it
 * sounds: the branch a new state would fall into is "visible", and a safety state that defaults to
 * visible is the one mistake this file exists to prevent.
 */
const EXPECTED: Record<
  ContentVisibilityState,
  { distributed: boolean; reachable: boolean; authorSees: 'UNDER_REVIEW' | 'NOT_APPROVED' | null }
> = {
  VISIBLE: { distributed: true, reachable: true, authorSees: null },
  // Out of feeds and search, still on the author's profile and at a direct link. The author is
  // told nothing: the demotion is provisional until a human looks, and telling them invites a
  // repost.
  LIMITED: { distributed: false, reachable: true, authorSees: null },
  HELD: { distributed: false, reachable: false, authorSees: 'UNDER_REVIEW' },
  PENDING_APPROVAL: { distributed: false, reachable: false, authorSees: 'UNDER_REVIEW' },
  REJECTED: { distributed: false, reachable: false, authorSees: 'NOT_APPROVED' },
};

describe('content visibility (§6.5)', () => {
  const states = Object.values(ContentVisibilityState);

  it('has a decision for every state the schema defines', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...states].sort());
  });

  it.each(states)('%s: distribution', state => {
    expect(isPublic(state)).toBe(EXPECTED[state].distributed);
  });

  it.each(states)('%s: a direct link', state => {
    expect(isReachable(state)).toBe(EXPECTED[state].reachable);
  });

  it.each(states)('%s: what the author is told', state => {
    expect(reviewStatusOf(state)).toBe(EXPECTED[state].authorSees);
  });

  it('distributes nothing it would not also serve on a direct link', () => {
    // The containment that makes the two fragments safe to mix: anything a feed may carry is also
    // reachable by link. If that ever inverted, a post could be in a feed and 404 when tapped.
    for (const state of states) {
      if (isPublic(state)) expect(isReachable(state)).toBe(true);
    }
  });
});

describe('the Prisma fragments', () => {
  it('filter to exactly the states the helpers agree with', () => {
    expect(PUBLIC_VISIBILITY.visibilityState).toBe(ContentVisibilityState.VISIBLE);
    expect([...DIRECT_VISIBILITY.visibilityState.in].sort()).toEqual(
      Object.values(ContentVisibilityState).filter(isReachable).sort(),
    );
  });

  it('is a mutable array, which is what a generated `in` filter takes', () => {
    // An `as const` here made the whole fragment unassignable to any `where`, which is how this
    // was found: the types rejected it everywhere at once.
    expect(Array.isArray(DIRECT_VISIBILITY.visibilityState.in)).toBe(true);
  });
});

describe('the raw-SQL fragments', () => {
  it('qualify the column with the alias they were given', () => {
    expect(publicVisibilitySql('u').sql).toContain('"u"."visibility_state"');
    expect(directVisibilitySql('m').sql).toContain('"m"."visibility_state"');
  });

  it('pass the states as parameters rather than inlining them', () => {
    expect(publicVisibilitySql('u').values).toEqual([ContentVisibilityState.VISIBLE]);
    expect(directVisibilitySql('u').values).toEqual([
      ContentVisibilityState.VISIBLE,
      ContentVisibilityState.LIMITED,
    ]);
  });
});

describe('what the author reads', () => {
  it('says what is happening without accusing anybody', () => {
    expect(REVIEW_MESSAGE.UNDER_REVIEW).toMatch(/reviewed/i);
    expect(REVIEW_MESSAGE.UNDER_REVIEW).not.toMatch(/violat|breach|banned|removed/i);
    expect(REVIEW_MESSAGE.NOT_APPROVED).toMatch(/not approved/i);
  });
});
