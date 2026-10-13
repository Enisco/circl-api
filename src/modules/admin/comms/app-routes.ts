/**
 * The deep links an announcement may carry (§5.18, S3.16).
 *
 * An allowlist of **patterns**, not a URL field, and that is a security boundary rather than a
 * convenience: an announcement reaches thousands of phones in Circl's name, and a free-text link
 * on it is the platform delivering whatever somebody typed — a phishing page with our logo above
 * it. So a route either matches one of these or the announcement is refused.
 *
 * The patterns are the routes the app already navigates to, taken from the notification `route`
 * values the product sections raise. `params` names the placeholders the portal's picker should
 * ask for; a pattern with none is a tab and needs nothing.
 *
 * Deliberately short. Every entry is a screen somebody could sensibly be sent to from a message
 * about the platform — not every screen that exists.
 */
export interface AppRoute {
  route: string;
  label: string;
  params?: string[];
}

export const APP_ROUTES: AppRoute[] = [
  { route: '/community', label: 'Community home' },
  { route: '/community/request/:id', label: 'One request', params: ['id'] },
  { route: '/community/offer/:id', label: 'One offer', params: ['id'] },
  { route: '/community/guide/:id', label: 'One guide', params: ['id'] },
  { route: '/community/group/:id', label: 'One group', params: ['id'] },
  { route: '/connect', label: 'Connect' },
  { route: '/connect/profile/:id', label: 'One Connect profile', params: ['id'] },
  { route: '/commerce', label: 'Marketplace' },
  { route: '/commerce/store/:id', label: 'One shop', params: ['id'] },
  { route: '/commerce/item/:id', label: 'One item', params: ['id'] },
  { route: '/professionals', label: 'Professionals' },
  { route: '/bookings', label: 'My bookings' },
  { route: '/messages', label: 'Messages' },
  { route: '/guard/resources', label: 'Getting help' },
  { route: '/settings/notifications', label: 'Notification settings' },
];

/**
 * Whether a concrete route matches one of the patterns.
 *
 * A segment-by-segment comparison rather than a regex built from the pattern: a `:id` accepts one
 * segment of url-safe characters and nothing else, so `/community/request/..%2f..` and
 * `/community/request/1/extra` are both refused. A regex assembled from a string is how a path
 * traversal gets through an allowlist that looked exhaustive.
 */
export const isAllowedRoute = (candidate: string): boolean => {
  if (!candidate.startsWith('/') || candidate.includes('..') || candidate.includes('//')) {
    return false;
  }

  // A query string or a fragment is refused rather than trimmed: a link carrying parameters
  // nobody validated is the thing this exists to stop.
  if (/[?#\s]/.test(candidate)) return false;

  const given = candidate.split('/').filter(Boolean);

  return APP_ROUTES.some(({ route }) => {
    const parts = route.split('/').filter(Boolean);

    if (parts.length !== given.length) return false;

    return parts.every((part, index) =>
      part.startsWith(':') ? /^[A-Za-z0-9_-]{1,64}$/.test(given[index]) : part === given[index],
    );
  });
};
