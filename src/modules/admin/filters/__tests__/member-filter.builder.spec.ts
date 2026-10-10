import { TaxonomyKind } from '@prisma/client';
import { CityService, TaxonomyService } from '@/modules/platform/shared';
import { AnalyticsFilterDto, ListMembersDto } from '../../dtos/analytics-filter.dto';
import { MemberFilterBuilder } from '../member-filter.builder';

/**
 * The builder emits the same population two ways — a Prisma `where` and a SQL predicate — and the
 * whole point of it is that those two agree. The member list exercises the SQL half end to end;
 * the Prisma half belongs to the analytics endpoints and exports, which have not shipped, so these
 * tests are what stops it being written once and discovered to be wrong months later.
 */
const bands = [
  {
    code: 'AGE_18_24',
    label: '18–24',
    description: null,
    sort: 0,
    isActive: true,
    metadata: { minAge: 18, maxAge: 24 },
  },
  {
    code: 'AGE_45_PLUS',
    label: '45+',
    description: null,
    sort: 1,
    isActive: true,
    metadata: { minAge: 45, maxAge: null },
  },
];

const terms = (codes: string[]) =>
  codes.map((code, index) => ({
    code,
    label: code,
    description: null,
    sort: index,
    isActive: true,
    metadata: null,
  }));

const build = () => {
  const cities = {
    resolve: jest.fn(async (id: string) =>
      ['LONDON', 'MANCHESTER'].includes(id) ? { id, name: id } : null,
    ),
  } as unknown as CityService;

  const taxonomy = {
    list: jest.fn(async (kind: TaxonomyKind) =>
      kind === TaxonomyKind.CONNECT_AGE_BAND
        ? bands
        : kind === TaxonomyKind.INTEREST
          ? terms(['FOOD_COOKING', 'TRAVEL'])
          : terms(['SETTLING_IN']),
    ),
  } as unknown as TaxonomyService;

  return new MemberFilterBuilder(cities, taxonomy);
};

const filter = (values: Partial<AnalyticsFilterDto>): AnalyticsFilterDto =>
  Object.assign(new AnalyticsFilterDto(), values);

describe('MemberFilterBuilder', () => {
  describe('the population', () => {
    it('always excludes staff, anonymised and deleted accounts', async () => {
      const { where, sql } = await build().resolve(filter({}));

      expect(where).toMatchObject({ isStaff: false, isAnonymised: false, deletedAt: null });
      expect(sql.sql).toContain('is_staff');
      expect(sql.sql).toContain('is_anonymised');
      expect(sql.sql).toContain('deleted_at');
    });

    it('carries no `AND` when nothing was filtered', async () => {
      const { where, applied } = await build().resolve(filter({}));

      expect(where.AND).toBeUndefined();
      expect(applied).toEqual([]);
    });
  });

  describe('the range', () => {
    it('defaults to thirty days ending today', async () => {
      const { range } = await build().resolve(filter({}));

      expect(range?.days).toBe(30);
      expect(range?.granularity).toBe('day');
      expect(range?.timezone).toBe('Europe/London');
    });

    it('has no range at all where the endpoint does not impose one', async () => {
      const { range } = await build().resolve(filter({}), { defaultRange: false });

      expect(range).toBeNull();
    });

    it('picks the granularity from the span', async () => {
      const month = await build().resolve(filter({ from: '2026-01-01', to: '2026-06-30' }));
      const year = await build().resolve(filter({ from: '2024-01-01', to: '2026-06-30' }));

      expect(month.range?.granularity).toBe('week');
      expect(year.range?.granularity).toBe('month');
    });

    it('refuses more than 366 daily buckets', async () => {
      await expect(
        build().resolve(filter({ from: '2024-01-01', to: '2026-01-01', granularity: 'day' })),
      ).rejects.toMatchObject({ code: 'FILTER_RANGE_TOO_LARGE' });
    });

    it('builds the comparison period as the equal span ending the day before', async () => {
      const { range } = await build().resolve(
        filter({ from: '2026-03-01', to: '2026-03-10', compare: true }),
      );

      expect(range?.previous).toMatchObject({ from: '2026-02-19', to: '2026-02-28' });
    });

    it('makes the last day whole, by taking the next midnight as an exclusive bound', async () => {
      const { range } = await build().resolve(filter({ from: '2026-07-01', to: '2026-07-01' }));

      // July is BST, so London midnight is 23:00 UTC the day before.
      expect(range?.fromInstant.toISOString()).toBe('2026-06-30T23:00:00.000Z');
      expect(range?.toInstant.toISOString()).toBe('2026-07-01T23:00:00.000Z');
    });

    it('applies the range to the sign-up date only where the endpoint says so', async () => {
      const without = await build().resolve(filter({ from: '2026-01-01', to: '2026-01-31' }));
      const with_ = await build().resolve(filter({ from: '2026-01-01', to: '2026-01-31' }), {
        dateField: 'createdAt',
      });

      expect(without.applied).not.toContain('signupDate');
      expect(with_.applied).toContain('signupDate');
      expect(JSON.stringify(with_.where)).toContain('createdAt');
    });
  });

  describe('vocabularies', () => {
    it('resolves city ids through the city service', async () => {
      const { where, sql } = await build().resolve(filter({ cityIds: ['LONDON'] }));

      expect(JSON.stringify(where)).toContain('LONDON');
      expect(sql.sql).toContain('city_id');
      expect(sql.values).toContain('LONDON');
    });

    it('refuses an unknown city as a bad request, not a quiet empty result', async () => {
      await expect(build().resolve(filter({ cityIds: ['ATLANTIS'] }))).rejects.toMatchObject({
        code: 'UNKNOWN_CITY',
      });
    });

    it('refuses an unknown taxonomy code', async () => {
      await expect(build().resolve(filter({ interests: ['KNITTING'] }))).rejects.toMatchObject({
        code: 'UNKNOWN_TAXONOMY_CODE',
      });
    });

    it('refuses something that is not an alpha-2 country code', async () => {
      await expect(
        build().resolve(filter({ countriesOfOrigin: ['NIGERIA'] })),
      ).rejects.toMatchObject({ code: 'UNKNOWN_TAXONOMY_CODE' });
    });

    it('treats OTHER as "no country recorded" rather than as a country', async () => {
      const { where, sql } = await build().resolve(filter({ countriesOfOrigin: ['OTHER'] }));

      expect(JSON.stringify(where)).toContain('countryOfOriginCode');
      expect(sql.sql).toContain('IS NULL');
    });
  });

  describe('"not set" is part of a filter, not the absence of one', () => {
    it('includes members with no profile row when UNKNOWN is asked for', async () => {
      const { where } = await build().resolve(filter({ gender: ['MALE', 'UNKNOWN'] }));
      const clause = JSON.stringify(where.AND);

      expect(clause).toContain('"gender":null');
      // The inner join is the trap: `profile: { … }` silently drops anybody who has never saved
      // a profile, who are exactly the people "unknown" is asking about.
      expect(clause).toContain('"profile":{"is":null}');
    });

    it('counts a member with no profile as not having completed onboarding', async () => {
      const { where } = await build().resolve(filter({ onboarding: 'not_completed' }));

      expect(JSON.stringify(where.AND)).toContain('"profile":{"is":null}');
    });

    it('does not widen "completed" to include them', async () => {
      const { where } = await build().resolve(filter({ onboarding: 'completed' }));

      expect(JSON.stringify(where.AND)).not.toContain('"is":null');
    });
  });

  describe('age bands', () => {
    it('becomes a birth-date range, so the page and the count see the same rows', async () => {
      const { where, sql } = await build().resolve(
        filter({ ageBands: ['AGE_18_24'], from: '2026-06-15', to: '2026-06-15' }),
      );

      expect(JSON.stringify(where)).toContain('dateOfBirth');
      expect(sql.sql).toContain('date_of_birth');
      // Judged at the end of the range, not at render time.
      expect(sql.values.map(String).some(value => value.includes('2001'))).toBe(true);
    });

    it('leaves the open-ended band open', async () => {
      const { sql } = await build().resolve(
        filter({ ageBands: ['AGE_45_PLUS'], from: '2026-06-15', to: '2026-06-15' }),
      );

      expect(sql.sql).toContain('<=');
      expect(sql.sql).not.toContain('>');
    });
  });

  describe('interests and languages', () => {
    it('matches any of the codes, not all of them', async () => {
      const { sql } = await build().resolve(filter({ interests: ['FOOD_COOKING', 'TRAVEL'] }));

      expect(sql.sql).toContain(' OR ');
      expect(sql.values).toContain('["FOOD_COOKING"]');
      expect(sql.values).toContain('["TRAVEL"]');
    });
  });

  describe('hasMemberAttributeFilters', () => {
    it('is false for a bare date range, which narrows no population', () => {
      expect(filter({ from: '2026-01-01', to: '2026-01-31' }).hasMemberAttributeFilters).toBe(
        false,
      );
    });

    it('is true for anything that does — including `onboarding`, which is not an array', () => {
      expect(filter({ cityIds: ['LONDON'] }).hasMemberAttributeFilters).toBe(true);
      expect(filter({ onboarding: 'completed' }).hasMemberAttributeFilters).toBe(true);
    });
  });

  describe('the list DTO', () => {
    it('inherits the shared filter and the paging helpers', () => {
      const dto = Object.assign(new ListMembersDto(), { page: 2, perPage: 50, hasStrikes: true });

      expect(dto.currentPage).toBe(2);
      expect(dto.size).toBe(50);
      expect(() => dto.sortField(['createdAt'], 'createdAt')).not.toThrow();
    });

    it('refuses a sort field that is not on the endpoint’s allowlist', () => {
      const dto = Object.assign(new ListMembersDto(), { sort: 'password' });

      expect(() => dto.sortField(['createdAt'], 'createdAt')).toThrow();
    });

    it('refuses a page deep enough to scan the whole table', () => {
      const dto = Object.assign(new ListMembersDto(), { page: 500, perPage: 100 });

      expect(() => dto.assertDepth()).toThrow();
    });
  });
});
