import { ADMIN_MODULES } from './admin';
import { CORE_MODULES } from './core';
import { INFRASTRUCTURE_MODULES } from './infrastructure';
import { ADMIN_SURFACE_DEPENDENCIES, PLATFORM_MODULES } from './platform';

/**
 * Which API this process serves.
 *
 * The admin surface and the member surface are kept separable, and this is where that becomes
 * something you can run rather than something written down: `APP_SURFACE=admin` boots the staff
 * API with no member routes in the process at all, and `APP_SURFACE=member` boots the member API
 * with no admin routes. If either stops booting on its own, the boundary has been broken, and that
 * shows up the next time anyone starts it rather than on the day somebody tries to split them.
 *
 * A flag rather than a second entrypoint on purpose: a second `main.ts` would duplicate a hundred
 * and seventy lines of bootstrap — CORS, pipes, filters, Swagger, the port check — and the copy
 * would drift from the original within a month.
 */
export type AppSurface = 'all' | 'member' | 'admin';

const MEMBER_MODULES = [...CORE_MODULES, ...INFRASTRUCTURE_MODULES, ...PLATFORM_MODULES];

export const modulesFor = (surface: AppSurface) => {
  switch (surface) {
    case 'admin':
      // Not "no member modules" — a handful, named in `ADMIN_SURFACE_DEPENDENCIES`, because staff
      // genuinely reply in member threads and sign member media. What this surface does not serve
      // is any member ROUTE: the product sections are absent, so a request to one is a 404 rather
      // than a 401, and a bug in the member API cannot be reached from the admin host at all.
      return [...INFRASTRUCTURE_MODULES, ...ADMIN_SURFACE_DEPENDENCIES, ...ADMIN_MODULES];
    case 'member':
      return MEMBER_MODULES;
    default:
      return [...MEMBER_MODULES, ...ADMIN_MODULES];
  }
};

/** Read once, at composition time: this is a deployment topology, not a runtime setting. */
export const appSurface = (): AppSurface => {
  const value = process.env.APP_SURFACE;

  return value === 'admin' || value === 'member' ? value : 'all';
};

export const MODULES = modulesFor(appSurface());
