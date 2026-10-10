import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { PATH_METADATA } from '@nestjs/common/constants';
import { IS_PUBLIC_KEY } from '@/common';
import {
  ADMIN_ANY_PERMISSION_KEY,
  ADMIN_AUTHENTICATED_KEY,
  ADMIN_PERMISSIONS_KEY,
} from './admin-principal';

/**
 * Refuses to start if any admin route forgot to say who may call it.
 *
 * The spec asks for a test that enumerates the routes and fails when one lacks permission
 * metadata. A test can be skipped, and it tells you after the code is written. The same scan runs
 * at boot and stops the process, naming the handler — so the omission cannot be deployed, cannot
 * be merged past a failing CI start, and cannot be argued with. The test exists as well, because a
 * test says which route and a refusal to boot says it louder.
 */
@Injectable()
export class AdminRouteAuditService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdminRouteAuditService.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onApplicationBootstrap(): void {
    const undeclared = this.undeclaredRoutes();

    if (!undeclared.length) {
      this.logger.log(`Admin routes checked: every handler declares who may call it.`);

      return;
    }

    throw new Error(
      `These admin route handlers declare no permissions, so nobody could call them and ` +
        `nothing says who should: ${undeclared.join(', ')}. Add @AdminPermissions(...), ` +
        `@AdminAnyPermission(...) or @AdminAuthenticated().`,
    );
  }

  /** Exported for the test, which asserts the same thing from the other side. */
  undeclaredRoutes(): string[] {
    const missing: string[] = [];

    for (const wrapper of this.discovery.getControllers()) {
      const { instance, metatype } = wrapper;

      if (!instance || !metatype) continue;

      const controllerPath = this.reflector.get<string>(PATH_METADATA, metatype) ?? '';

      // Only the admin surface. The member controllers are allowed to be open where they say so.
      if (!controllerPath.startsWith('admin')) continue;

      const prototype = Object.getPrototypeOf(instance) as object;

      for (const method of this.scanner.getAllMethodNames(prototype)) {
        const handler = (instance as Record<string, unknown>)[method];

        if (typeof handler !== 'function') continue;
        if (this.reflector.get(PATH_METADATA, handler) === undefined) continue;

        const declared = [
          ADMIN_PERMISSIONS_KEY,
          ADMIN_ANY_PERMISSION_KEY,
          ADMIN_AUTHENTICATED_KEY,
          // `@Public()` is a declaration as well: it says "this one authenticates nobody", which
          // is a sentence somebody wrote on purpose rather than a gap.
          IS_PUBLIC_KEY,
        ].some(key => {
          const value = this.reflector.getAllAndOverride<unknown>(key, [handler, metatype]);

          return Array.isArray(value) ? value.length > 0 : Boolean(value);
        });

        if (!declared) missing.push(`${metatype.name}.${method}`);
      }
    }

    return missing;
  }
}
