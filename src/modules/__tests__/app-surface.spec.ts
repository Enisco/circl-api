import { PATH_METADATA } from '@nestjs/common/constants';
import { ADMIN_MODULES } from '../admin';
import { CORE_MODULES } from '../core';
import { PLATFORM_MODULES } from '../platform';
import { modulesFor } from '..';

const names = (modules: unknown[]) =>
  modules.map(module => (module as { name?: string }).name ?? String(module));

type ModuleLike = {
  name?: string;
  module?: unknown;
  imports?: unknown[];
  controllers?: unknown[];
};

/**
 * Every controller path a surface would mount, found by walking the module graph.
 *
 * The name-based version of this test is what let the leak through: it listed the four modules the
 * admin surface is allowed to import and asserted nothing about what they *mount*. Three of them
 * declared member controllers, so `APP_SURFACE=admin` served twenty-four member routes while six
 * green checks said the boundary held.
 *
 * So this reads the same metadata Nest reads. Dynamic modules (`RouterModule.register(...)`,
 * `JwtModule.register({})`) are objects carrying their own `imports` and `controllers` rather than
 * classes with metadata, so both shapes are handled — a walk that silently skipped them would be
 * the same mistake in a new place.
 */
const controllerPaths = (modules: unknown[]): string[] => {
  const seen = new Set<unknown>();
  const paths: string[] = [];

  const visit = (entry: unknown): void => {
    if (!entry || seen.has(entry)) return;

    seen.add(entry);

    const node = entry as ModuleLike;
    // A dynamic module names the class it configures; the class may carry metadata of its own.
    const subject = node.module ?? entry;

    if (subject !== entry) visit(subject);

    const metadata = (key: string): unknown[] =>
      (Reflect.getMetadata(key, subject as object) as unknown[]) ?? [];

    for (const controller of [...(node.controllers ?? []), ...metadata('controllers')]) {
      const path = Reflect.getMetadata(PATH_METADATA, controller as object);

      paths.push(typeof path === 'string' ? path : String(path));
    }

    for (const imported of [...(node.imports ?? []), ...metadata('imports')]) {
      visit(imported);
    }
  };

  modules.forEach(visit);

  return [...new Set(paths)];
};

/**
 * The two APIs have to stay separable, and "separable" is only true if each half still composes on
 * its own. The lint rules stop the imports that would break it; this stops the composition that
 * would — somebody adding a product module to the admin surface to get at one service, which is
 * how a boundary quietly becomes a suggestion.
 */
describe('app surfaces', () => {
  const productModules = PLATFORM_MODULES.filter(
    module =>
      !['PlatformSharedModule', 'NotificationsModule', 'MessagingModule', 'MediaModule'].includes(
        (module as { name: string }).name,
      ),
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
    // threads. What it must not contain is a module that serves member ROUTES, which the next
    // test asserts directly rather than by name.
    for (const module of names(productModules)) {
      expect(admin).not.toContain(module);
    }
  });

  it('mounts nothing but admin routes on the admin surface', () => {
    const paths = controllerPaths(modulesFor('admin'));

    // The check the name-based ones could not make. Every controller reachable from this surface
    // has to live under `admin`, because anything else is a member route on a host that is not
    // supposed to answer member requests — and would answer `500 Unknown authentication strategy
    // "jwt"` rather than a 404, the member strategy not being registered here.
    // `health` is the one exception, and it belongs on every surface: a host nothing can ask
    // "are you up" is a host nothing can deploy.
    expect(paths.filter(path => !path.startsWith('admin') && path !== 'health')).toEqual([]);
    // And the admin routes really are there, so a walk that found nothing cannot pass.
    expect(paths).toContain('admin/support');
    expect(paths).toContain('admin/media');
  });

  it('still mounts the member routes on the member surface', () => {
    const paths = controllerPaths(modulesFor('member'));

    // The other half of the split: the controllers moved out of the core modules have to be
    // mounted by the modules that replaced them, or this fix would have silently removed the
    // member messaging API from the member API.
    expect(paths).toContain('messages');
    expect(paths).toContain('presence');
    expect(paths).toContain('notifications');
    expect(paths).toContain('media');
    expect(paths.filter(path => path.startsWith('admin'))).toEqual([]);
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
    expect(admin).toContain('MediaCoreModule');
    expect(admin).toContain('NotificationsCoreModule');
  });
});
