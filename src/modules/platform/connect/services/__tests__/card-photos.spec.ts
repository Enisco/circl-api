import { ConnectMediaItemView } from '../connect-media.service';
import { cardPhotosFrom } from '../connect-profile.service';

/**
 * Connect v2 §1: which photographs are the card.
 *
 * Worth testing as a pure function rather than through the endpoint, because the interesting cases
 * are all about **disagreement between the list and reality** — an id that was deleted, a video
 * among the photos, a member who picked nothing, a list longer than the limit. Each of those is a
 * profile read that either comes back short, comes back wrong, or throws, and only one of the three
 * is acceptable.
 */
const photo = (id: string, position: number): ConnectMediaItemView => ({
  id,
  kind: 'PHOTO',
  url: `https://example.test/${id}.jpg`,
  thumbnailUrl: `https://example.test/${id}-thumb.jpg`,
  width: 1200,
  height: 1600,
  durationMs: null,
  position,
});

const video = (id: string, position: number): ConnectMediaItemView => ({
  ...photo(id, position),
  kind: 'VIDEO',
  durationMs: 8_000,
});

const post = (id: string, items: ConnectMediaItemView[], position: number) => ({
  id,
  caption: null,
  postedAt: '2026-10-01T00:00:00.000Z',
  position,
  items,
});

const posts = [
  post('p1', [photo('a', 0), photo('b', 1)], 0),
  post('p2', [video('v', 0), photo('c', 1)], 1),
  post('p3', [photo('d', 0)], 2),
];

describe('the Connect card', () => {
  it('is the member’s own three photographs, in the order they chose', () => {
    expect(cardPhotosFrom(posts, ['d', 'a', 'c'], 3).map(item => item.id)).toEqual(['d', 'a', 'c']);
  });

  it('falls back to post order when they have not chosen, which is what the client used to derive', () => {
    // The old rule exactly: flatten the posts in order, photos only, and the first one is the
    // cover. A profile nobody has re-edited has to read identically to before the field existed.
    expect(cardPhotosFrom(posts, [], 3).map(item => item.id)).toEqual(['a', 'b', 'c']);
    expect(cardPhotosFrom(posts, null, 3).map(item => item.id)).toEqual(['a', 'b', 'c']);
    expect(cardPhotosFrom(posts, undefined, 3).map(item => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('never puts a video on the card, in either path', () => {
    // The fallback skips it, and an explicit pick of it resolves to nothing — the write refuses a
    // video id, so this is the belt to that braces.
    expect(cardPhotosFrom(posts, [], 9).some(item => item.kind === 'VIDEO')).toBe(false);
    expect(cardPhotosFrom(posts, ['v'], 3)).toEqual([]);
  });

  it('skips an id whose photo has gone rather than failing the read', () => {
    // A member deletes the post a card photo came from. The card is shorter until they pick
    // again; the profile still loads. Pruning keeps the column tidy, and this is why a stale id
    // cannot break anything in the meantime.
    expect(cardPhotosFrom(posts, ['a', 'gone', 'c'], 3).map(item => item.id)).toEqual(['a', 'c']);
    expect(cardPhotosFrom(posts, ['gone', 'also-gone'], 3)).toEqual([]);
  });

  it('honours the limit in both paths, so a stale longer list cannot widen the card', () => {
    expect(cardPhotosFrom(posts, ['d', 'c', 'b', 'a'], 3).map(item => item.id)).toEqual([
      'd',
      'c',
      'b',
    ]);
    expect(cardPhotosFrom(posts, [], 2).map(item => item.id)).toEqual(['a', 'b']);
  });

  it('returns the whole item, so a card renders without reading the gallery', () => {
    // §1 asks for the same shape as post media: the card has to be drawable from this field alone.
    const [cover] = cardPhotosFrom(posts, ['b'], 3);

    expect(cover).toEqual(
      expect.objectContaining({
        id: 'b',
        url: expect.any(String),
        thumbnailUrl: expect.any(String),
        width: 1200,
        height: 1600,
      }),
    );
  });

  it('is empty for a profile with no photos at all, rather than throwing', () => {
    expect(cardPhotosFrom([], ['a'], 3)).toEqual([]);
    expect(cardPhotosFrom([], [], 3)).toEqual([]);
  });

  it('does not reorder a duplicate into the card twice', () => {
    // The write refuses duplicates outright; if one ever reached the column, the card would show
    // the same face twice in a three-card swipe, which is the bug nobody can see while picking.
    const ids = cardPhotosFrom(posts, ['a', 'a', 'b'], 3).map(item => item.id);

    expect(new Set(ids).size).toBe(ids.length);
  });
});
