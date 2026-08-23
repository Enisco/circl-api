import { FeedItemType } from '@prisma/client';
import { FeedRankerService, RankableItem, ViewerSignals } from '../feed-ranker.service';

const NOW = new Date('2026-08-23T12:00:00.000Z');

const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);
const daysFromNow = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

const item = (overrides: Partial<RankableItem> = {}): RankableItem => ({
  type: FeedItemType.REQUEST,
  id: 'req_1',
  createdAt: hoursAgo(1),
  cityId: 'MANCHESTER',
  categoryCode: 'VISA_DOCS',
  engagement: 0,
  authorId: 'usr_1',
  ...overrides,
});

const viewer = (overrides: Partial<ViewerSignals> = {}): ViewerSignals => ({
  cityId: 'MANCHESTER',
  journeyStage: 'JUST_ARRIVED',
  interests: [],
  affinity: new Map(),
  suppressed: new Set(),
  ...overrides,
});

describe('FeedRankerService', () => {
  const ranker = new FeedRankerService();

  it("ranks a post in the viewer's city above an identical one elsewhere", () => {
    const [first] = ranker.rank(
      [item({ id: 'far', cityId: 'LONDON' }), item({ id: 'near', cityId: 'MANCHESTER' })],
      viewer(),
      NOW,
    );

    expect(first.item.id).toBe('near');
    expect(first.signals).toContain('CITY_MATCH');
  });

  // D3: an eight-month-old airport-pickup offer must never outrank a request for
  // tomorrow morning.
  it('decays offers hard enough that an old one loses to a fresh urgent request', () => {
    const ranked = ranker.rank(
      [
        item({
          id: 'old_offer',
          type: FeedItemType.OFFER,
          createdAt: hoursAgo(24 * 240),
          categoryCode: 'AIRPORT_PICKUP',
          engagement: 200,
        }),
        item({ id: 'urgent_request', createdAt: hoursAgo(2), neededOn: daysFromNow(1) }),
      ],
      viewer(),
      NOW,
    );

    expect(ranked[0].item.id).toBe('urgent_request');
    expect(ranked[0].signals).toContain('URGENT');
  });

  it('treats a deadline that has passed as stale rather than urgent', () => {
    const [only] = ranker.rank(
      [item({ neededOn: new Date(NOW.getTime() - 86_400_000) })],
      viewer(),
      NOW,
    );

    expect(only.signals).not.toContain('URGENT');
  });

  it('drops items the member asked to see less of', () => {
    const ranked = ranker.rank(
      [item({ id: 'hidden' }), item({ id: 'shown' })],
      viewer({ suppressed: new Set(['hidden']) }),
      NOW,
    );

    expect(ranked.map(entry => entry.item.id)).toEqual(['shown']);
  });

  it('saturates category affinity so one interest cannot take over the feed', () => {
    const heavy = ranker.rank(
      [item({ categoryCode: 'ACCOMMODATION' })],
      viewer({ affinity: new Map([['ACCOMMODATION', 400]]) }),
      NOW,
    )[0].score;

    const moderate = ranker.rank(
      [item({ categoryCode: 'ACCOMMODATION' })],
      viewer({ affinity: new Map([['ACCOMMODATION', 20]]) }),
      NOW,
    )[0].score;

    // Twenty times the engagement must not be twenty times the score.
    expect(heavy - moderate).toBeLessThan(6);
  });

  // D7: a wrong explanation of why something was surfaced is worse than none.
  it('returns a null reason rather than a template when nothing meaningful fired', () => {
    const [only] = ranker.rank(
      [item({ cityId: 'LONDON', categoryCode: 'OTHER', createdAt: hoursAgo(200) })],
      viewer({ journeyStage: null }),
      NOW,
    );

    expect(only.reason).toBeNull();
  });

  it('builds a reason only from signals that actually fired', () => {
    const [only] = ranker.rank(
      [item({ neededOn: daysFromNow(2) })],
      viewer({ journeyStage: 'JUST_ARRIVED' }),
      NOW,
    );

    expect(only.reason).toContain('newly arrived');
    expect(only.reason).toContain('near you');
  });
});
