import { ContentVisibilityState } from '@prisma/client';
import { connectVisibility } from '../connect-visibility';

const visible = { isVisible: true, deletedAt: null };

/**
 * The rule that keeps a community profile from becoming a way to find people who left discovery.
 * Two places ask it — the Connect profile route and the `alsoOn` block — and this is why they ask
 * the same one rather than each carrying a copy.
 */
describe('connectVisibility', () => {
  it('lets a member of Connect see a visible profile', () => {
    expect(
      connectVisibility({ viewerHasProfile: true, target: visible, isBlockedEitherWay: false }),
    ).toBe('VISIBLE');
  });

  it.each([ContentVisibilityState.HELD, ContentVisibilityState.REJECTED])(
    'refuses a profile whose own words are %s — the same answer hidden gets (§6.5)',
    visibilityState => {
      expect(
        connectVisibility({
          viewerHasProfile: true,
          target: { ...visible, visibilityState },
          isBlockedEitherWay: false,
        }),
      ).toBe('NOT_FOUND');
    },
  );

  it('still shows a limited profile: it is out of the grid, not out of existence', () => {
    expect(
      connectVisibility({
        viewerHasProfile: true,
        target: { ...visible, visibilityState: ContentVisibilityState.LIMITED },
        isBlockedEitherWay: false,
      }),
    ).toBe('VISIBLE');
  });

  it('treats a caller that has not loaded the column as it behaved before §6.5', () => {
    expect(
      connectVisibility({ viewerHasProfile: true, target: visible, isBlockedEitherWay: false }),
    ).toBe('VISIBLE');
  });

  it('refuses a viewer who has not joined Connect, whatever the target', () => {
    expect(
      connectVisibility({ viewerHasProfile: false, target: visible, isBlockedEitherWay: false }),
    ).toBe('NO_OWN_PROFILE');
  });

  it.each([
    ['hidden', { isVisible: false, deletedAt: null }],
    ['deleted', { isVisible: true, deletedAt: new Date() }],
    ['absent', null],
  ])('gives one answer for a profile that is %s', (_case, target) => {
    expect(connectVisibility({ viewerHasProfile: true, target, isBlockedEitherWay: false })).toBe(
      'NOT_FOUND',
    );
  });

  it('and the same answer when either has blocked the other', () => {
    // Deliberately indistinguishable from hidden: telling them apart would say which it was.
    expect(
      connectVisibility({ viewerHasProfile: true, target: visible, isBlockedEitherWay: true }),
    ).toBe('NOT_FOUND');
  });

  it('checks the viewer before the target, so a stranger learns nothing about them', () => {
    // A viewer with no profile of their own is refused whether or not the target exists, so the
    // response cannot be used to probe for one.
    const withTarget = connectVisibility({
      viewerHasProfile: false,
      target: visible,
      isBlockedEitherWay: false,
    });
    const without = connectVisibility({
      viewerHasProfile: false,
      target: null,
      isBlockedEitherWay: false,
    });

    expect(withTarget).toBe(without);
  });
});
