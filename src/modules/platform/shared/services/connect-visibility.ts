/**
 * Who may be told that somebody has a Connect profile.
 *
 * A member can take themselves out of discovery while keeping their profile, so anywhere else that
 * mentions Connect has to ask the same question discovery asks — or a community profile becomes a
 * way to find people who chose not to be found, from a screen that never mentions Connect.
 *
 * A pure rule rather than a service, so both callers reach it without a module edge between them,
 * and so there is one answer rather than two that can drift.
 */
export type ConnectVisibility = 'VISIBLE' | 'NO_OWN_PROFILE' | 'NOT_FOUND';

export interface ConnectVisibilityInput {
  /** The viewer's own profile, which the reciprocity gate requires (3.4). */
  viewerHasProfile: boolean;
  target: { isVisible: boolean; deletedAt: Date | null } | null;
  isBlockedEitherWay: boolean;
}

/**
 * The three outcomes discovery already distinguishes: the viewer has not joined Connect, or the
 * profile is not theirs to see. Hidden, deleted and blocked are deliberately one answer — telling
 * them apart would say which it was.
 *
 * Not a question about the viewer's own profile: that is ownership, not visibility, and the caller
 * answers it before asking.
 */
export const connectVisibility = (input: ConnectVisibilityInput): ConnectVisibility => {
  if (!input.viewerHasProfile) return 'NO_OWN_PROFILE';
  if (!input.target || input.target.deletedAt !== null || !input.target.isVisible) {
    return 'NOT_FOUND';
  }
  if (input.isBlockedEitherWay) return 'NOT_FOUND';

  return 'VISIBLE';
};
