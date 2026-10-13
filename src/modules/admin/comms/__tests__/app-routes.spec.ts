import { APP_ROUTES, isAllowedRoute } from '../app-routes';

/**
 * The allowlist is a security boundary, not a convenience: an announcement reaches thousands of
 * phones in Circl's name, so a `route` on one is the platform delivering whatever somebody typed.
 * These are the ways a string tries to get past a list of patterns.
 */
describe('announcement deep links', () => {
  it.each(APP_ROUTES.filter(route => !route.params).map(route => route.route))(
    'accepts the tab %s',
    route => {
      expect(isAllowedRoute(route)).toBe(true);
    },
  );

  it('accepts a pattern with its parameter filled in', () => {
    expect(isAllowedRoute('/community/request/9f3a1b2c')).toBe(true);
    expect(isAllowedRoute('/connect/profile/abc-123_X')).toBe(true);
  });

  it.each([
    ['a screen that is not on the list', '/admin/members'],
    ['an absolute URL', 'https://evil.example.com/phish'],
    ['a protocol-relative URL', '//evil.example.com'],
    ['a scheme with no host', 'javascript:alert(1)'],
    ['a traversal', '/community/request/../../admin'],
    ['an encoded traversal', '/community/request/..%2f..%2fadmin'],
    ['an extra segment past the parameter', '/community/request/1/edit'],
    ['a missing parameter', '/community/request'],
    ['a query string nobody validated', '/community/request/1?redirect=https://evil.test'],
    ['a fragment', '/community/request/1#x'],
    ['a parameter with a slash in it', '/community/request/a/b'],
    ['whitespace', '/community/request/1 '],
    ['empty', ''],
  ])('refuses %s', (_label, candidate) => {
    expect(isAllowedRoute(candidate)).toBe(false);
  });

  it('lists only routes that pass its own check, so the picker cannot offer a dead option', () => {
    const concrete = APP_ROUTES.map(({ route, params }) =>
      (params ?? []).reduce((path, param) => path.replace(`:${param}`, 'example1'), route),
    );

    expect(concrete.filter(route => !isAllowedRoute(route))).toEqual([]);
  });
});
