import { ADMIN_MODULES } from '../admin';
import { CORE_MODULES } from '../core';
import { PLATFORM_MODULES } from '../platform';
import { modulesFor } from '..';

const names = (modules: unknown[]) =>
  modules.map(module => (module as { name?: string }).name ?? String(module));

/**
 * The two APIs have to stay separable, and "separable" is only true if each half still composes on
 * its own. The lint rules stop the imports that would break it; this stops the composition that
 * would — somebody adding a product module to the admin surface to get at one service, which is
 * how a boundary quietly becomes a suggestion.
 */
describe('app surfaces', () => {
  const productModules = PLATFORM_MODULES.filter(
    module =>
      ![
        'PlatformSharedModule',
        'NotificationsModule',
        'MessagingCoreModule',
        'MediaModule',
      ].includes((module as { name: string }).name),
  );

  it('serves both APIs by default, which is the single-process deployment', () => {
    const all = names(modulesFor('all'));

    expect(all).toEqual(expect.arrayContaining(names(ADMIN_MODULES)));
    expect(all).toEqual(expect.arrayContaining(names(PLATFORM_MODULES)));
    expect(all).toEqual(expect.arrayContaining(names(CORE_MODULES)));
  });

  it('leaves every admin module out of the member surface', () => {
    const member = names(modulesFor('member'));

    for (const module of names(ADMIN_MODULES)) {
      expect(member).not.toContain(module);
    }
  });

  it('leaves every member PRODUCT module out of the admin surface', () => {
    const admin = names(modulesFor('admin'));

    // Not "no platform modules": the admin API genuinely signs member media and writes to member
    // threads. What it must not contain is a module that serves member ROUTES, because then
    // `APP_SURFACE=admin` would be a host answering member requests.
    for (const module of names(productModules)) {
      expect(admin).not.toContain(module);
    }
  });

  it('does not pull the job runner into the admin surface', () => {
    // It schedules every product section's work, so importing it would drag them all back in. The
    // admin API resolves it by name at call time instead.
    expect(names(modulesFor('admin'))).not.toContain('PlatformJobsModule');
  });

  it('keeps the member authentication modules out of the admin surface', () => {
    const admin = names(modulesFor('admin'));

    for (const module of names(CORE_MODULES)) {
      expect(admin).not.toContain(module);
    }
  });

  it('includes the admin modules in the admin surface, and its declared dependencies', () => {
    const admin = names(modulesFor('admin'));

    expect(admin).toEqual(expect.arrayContaining(names(ADMIN_MODULES)));
    expect(admin).toContain('PlatformSharedModule');
    expect(admin).toContain('MessagingCoreModule');
  });
});
