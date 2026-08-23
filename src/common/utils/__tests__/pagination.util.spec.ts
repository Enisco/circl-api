import { buildPageMeta, decodeCursor, encodeCursor } from '../pagination.util';

describe('buildPageMeta', () => {
  it('reports 0 total pages on an empty result rather than "page 1 of 1"', () => {
    const meta = buildPageMeta({ currentPage: 1, perPage: 20 }, 0);

    expect(meta.totalPages).toBe(0);
    expect(meta.hasNextPage).toBe(false);
    expect(meta.hasPreviousPage).toBe(false);
  });

  it('computes both page flags so the client never has to', () => {
    const meta = buildPageMeta({ currentPage: 2, perPage: 20 }, 134);

    expect(meta).toMatchObject({
      currentPage: 2,
      perPage: 20,
      totalPages: 7,
      totalCount: 134,
      hasNextPage: true,
      hasPreviousPage: true,
    });
  });

  it('marks the last page as having no next', () => {
    expect(buildPageMeta({ currentPage: 7, perPage: 20 }, 134).hasNextPage).toBe(false);
  });
});

describe('feed cursors', () => {
  it('round-trips', () => {
    expect(decodeCursor(encodeCursor({ offset: 40, ranking: 'PERSONALISED' }))).toEqual({
      offset: 40,
      ranking: 'PERSONALISED',
    });
  });

  it('returns null for a mangled cursor rather than throwing into the query', () => {
    expect(decodeCursor('not-a-cursor')).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
  });
});
