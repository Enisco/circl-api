import {
  BriefUrgency,
  ExperienceLevel,
  FeedItemType,
  Gender,
  StoreStatus,
  TaxonomyKind,
} from '@prisma/client';
import { COMMERCE_SORTS } from '../../commerce/dtos/store.dto';
import { PROFESSIONAL_SORTS } from '../../professionals/dtos/browse.dto';
import { taxonomySeeds } from '../../../../../prisma/seeders/data/taxonomy';

const codesOf = (kind: TaxonomyKind) =>
  taxonomySeeds
    .filter(term => term.kind === kind)
    .map(term => term.code)
    .sort();

const sorted = (values: readonly string[]) => [...values].sort();

/**
 * Where a vocabulary is also a thing the server validates, the taxonomy's codes have to BE those
 * values. The client picks a chip and sends its code straight back; a code the endpoint does not
 * accept is a filter that silently matches nothing, which is the fault this taxonomy exists to fix.
 */
describe('taxonomy codes are the codes the API accepts', () => {
  it.each([
    ['EXPERIENCE_LEVEL', TaxonomyKind.EXPERIENCE_LEVEL, Object.values(ExperienceLevel)],
    ['GENDER', TaxonomyKind.GENDER, Object.values(Gender)],
    ['URGENCY', TaxonomyKind.URGENCY, Object.values(BriefUrgency)],
    ['PROFESSIONAL_SORT_OPTION', TaxonomyKind.PROFESSIONAL_SORT_OPTION, PROFESSIONAL_SORTS],
    ['COMMERCE_SORT_OPTION', TaxonomyKind.COMMERCE_SORT_OPTION, COMMERCE_SORTS],
  ])('%s matches the values the server validates', (_name, kind, values) => {
    expect(codesOf(kind)).toEqual(sorted(values));
  });

  it('feed types are the three the feed can actually return', () => {
    // GUIDE is a real FeedItemType and is deliberately not a chip: the feed drops guides whether
    // or not they are asked for, because they have their own tab, so the chip could only ever come
    // back empty. Every code here is still a FeedItemType.
    const codes = codesOf(TaxonomyKind.FEED_TYPE);

    expect(codes).toEqual(['OFFER', 'REQUEST', 'UPDATE']);
    expect(codes.every(code => (Object.values(FeedItemType) as string[]).includes(code))).toBe(true);
    expect(codes).not.toContain(FeedItemType.GUIDE);
  });

  it('request statuses are the three the endpoint takes, not all five states', () => {
    // CLOSED stands for resolved, closed and expired, which is what the filter row means by it.
    expect(codesOf(TaxonomyKind.REQUEST_STATUS)).toEqual(['ALL', 'CLOSED', 'OPEN']);
  });

  it('store statuses are protocol and stay out of the taxonomy', () => {
    // The app branches on these, so a seventh one from a portal would make it fall to a default
    // rather than do anything. Listed here so the boundary is written down, not just understood.
    expect(Object.values(StoreStatus).length).toBeGreaterThan(0);
    expect(taxonomySeeds.some(term => term.code === 'HOLIDAY')).toBe(false);
  });

  it('an interest can actually match something in the feed', () => {
    // The ranker scores an item when `viewer.interests` contains the item's `categoryCode`, which
    // is a community category. An interest vocabulary sharing no codes with that one is a
    // personalisation signal that can never fire, whatever the member picks.
    const interests = new Set(codesOf(TaxonomyKind.INTEREST));
    const categories = codesOf(TaxonomyKind.COMMUNITY_CATEGORY);
    const matchable = categories.filter(code => interests.has(code));

    expect(matchable.length).toBeGreaterThanOrEqual(15);
  });

  it('every code is UPPER_SNAKE, because a label is never a code', () => {
    const wrong = taxonomySeeds
      .filter(term => term.kind !== TaxonomyKind.COUNTRY_OF_ORIGIN)
      .filter(term => !/^[A-Z][A-Z0-9_]*$/.test(term.code))
      .map(term => `${term.kind}:${term.code}`);

    expect(wrong).toEqual([]);
  });

  it('and no kind is declared and then left empty', () => {
    const seeded = new Set(taxonomySeeds.map(term => term.kind));
    const empty = Object.values(TaxonomyKind).filter(kind => !seeded.has(kind));

    // PRIVATE_HELP_CATEGORY is served from GUARD_CATEGORY, whose codes 6.3.1 fixes.
    expect(empty).toEqual([TaxonomyKind.PRIVATE_HELP_CATEGORY]);
  });
});
