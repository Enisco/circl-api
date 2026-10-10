import { Injectable } from '@nestjs/common';
import { CacheService, PrismaService } from '@/infrastructure';

/**
 * A short time to live as well as an invalidation.
 *
 * The spec caches these until something invalidates them. A missed invalidation would then last
 * until the process restarted, and the thing it would be holding on to is a permission somebody
 * was supposed to lose. A minute's TTL means a missed invalidation heals itself; role changes also
 * revoke the staff member's sessions, so in practice the window is shorter still.
 */
const TTL_SECONDS = 60;

@Injectable()
export class AdminPermissionService {
  constructor(
    private readonly database: PrismaService,
    private readonly cache: CacheService,
  ) {}

  private key = (roleCode: string) => `admin:role-perms:${roleCode}`;

  /** The permission codes a role grants, resolved server-side on every request. */
  async forRole(roleCode: string): Promise<Set<string>> {
    const cached = await this.cache.get<string[]>(this.key(roleCode));

    if (cached) return new Set(cached);

    const role = await this.database.role.findUnique({
      where: { code: roleCode },
      select: { rolePermissions: { select: { permission: { select: { code: true } } } } },
    });

    const codes = (role?.rolePermissions ?? []).map(row => row.permission.code);

    await this.cache.set(this.key(roleCode), codes, TTL_SECONDS);

    return new Set(codes);
  }

  async invalidate(roleCode: string): Promise<void> {
    await this.cache.delete(this.key(roleCode));
  }

  async invalidateAll(): Promise<void> {
    const roles = await this.database.role.findMany({ select: { code: true } });

    await this.cache.delete(...roles.map(role => this.key(role.code)));
  }
}
