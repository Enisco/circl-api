import { Injectable, Logger } from '@nestjs/common';
import { CacheService, PrismaService } from '@/infrastructure';
import { SYSTEM_CONFIG_DEFAULTS, SystemConfigKey, SystemConfigValues, toJson } from '@/common';

/**
 * A setting that staff can change, read with a default that means nothing has to be seeded.
 *
 * Reads go through Redis for sixty seconds, which is the compromise the spec asks for: a change
 * made in the portal takes effect within a minute everywhere, and a limit consulted on every
 * profile save does not become a database read on every profile save.
 *
 * An absent row is not an error, and neither is a row whose value is the wrong shape — both fall
 * back to the compiled default and say so in the log. The alternative is a bad row in a
 * configuration table taking the platform down, which is precisely the failure mode that makes
 * people hard-code constants in the first place.
 */
@Injectable()
export class SystemConfigService {
  private readonly logger = new Logger(SystemConfigService.name);

  private static readonly TTL_SECONDS = 60;
  private static readonly PREFIX = 'system-config:';

  constructor(
    private readonly database: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async get<K extends SystemConfigKey>(key: K): Promise<SystemConfigValues[K]> {
    const fallback = SYSTEM_CONFIG_DEFAULTS[key];

    try {
      const cached = await this.cache.get<{ value: SystemConfigValues[K] }>(
        `${SystemConfigService.PREFIX}${key}`,
      );

      if (cached) return cached.value;

      const row = await this.database.systemConfig.findUnique({ where: { key } });
      const value = this.coerce(key, row?.value, fallback);

      // Wrapped in an object: `CacheService.get` treats a falsy payload as a miss, and several of
      // these values are legitimately `0` or `false`.
      await this.cache.set(
        `${SystemConfigService.PREFIX}${key}`,
        { value },
        SystemConfigService.TTL_SECONDS,
      );

      return value;
    } catch (error) {
      this.logger.warn({
        event: 'system_config_read_failed',
        key,
        message: (error as Error).message,
      });

      return fallback;
    }
  }

  /** Several keys at once, for an endpoint that needs a handful. */
  async getMany<K extends SystemConfigKey>(
    ...keys: K[]
  ): Promise<{ [P in K]: SystemConfigValues[P] }> {
    const entries = await Promise.all(keys.map(async key => [key, await this.get(key)] as const));

    return Object.fromEntries(entries) as { [P in K]: SystemConfigValues[P] };
  }

  /** Writes an override and drops the cached copy, so the change is live within one read. */
  async set<K extends SystemConfigKey>(key: K, value: SystemConfigValues[K]): Promise<void> {
    await this.database.systemConfig.upsert({
      where: { key },
      update: { value: toJson(value) },
      create: { key, value: toJson(value) },
    });

    await this.cache.delete(`${SystemConfigService.PREFIX}${key}`);
  }

  /**
   * Drops the cached copy of one key without writing anything.
   *
   * For a caller that has already written the row itself — §5.21's `PATCH admin/config/:key`
   * writes it inside the audit transaction, because S11.1 wants the change and its trail to stand
   * or fall together, and `set` above cannot join a transaction it does not know about. Without
   * this the staff member who made the change would read the old value back for up to a minute
   * and reasonably conclude it had not saved.
   */
  async invalidate(key: SystemConfigKey): Promise<void> {
    await this.cache.delete(`${SystemConfigService.PREFIX}${key}`);
  }

  /**
   * A stored value, if it is the same shape as the default; otherwise the default.
   *
   * Shape rather than schema: a number stays a number, an array stays an array, and an object keeps
   * the default's keys for any it does not supply. That last part is what makes adding a key to a
   * grouped setting safe — `safety.classifier` gaining a field does not invalidate every row that
   * was written before it existed.
   */
  private coerce<K extends SystemConfigKey>(
    key: K,
    stored: unknown,
    fallback: SystemConfigValues[K],
  ): SystemConfigValues[K] {
    if (stored === null || stored === undefined) return fallback;

    if (Array.isArray(fallback)) {
      return (Array.isArray(stored) ? stored : fallback) as SystemConfigValues[K];
    }

    if (typeof fallback === 'object') {
      if (typeof stored !== 'object' || Array.isArray(stored)) {
        this.logger.warn({ event: 'system_config_shape_ignored', key });

        return fallback;
      }

      return { ...fallback, ...(stored as object) } as SystemConfigValues[K];
    }

    if (typeof stored !== typeof fallback) {
      this.logger.warn({ event: 'system_config_shape_ignored', key });

      return fallback;
    }

    return stored as SystemConfigValues[K];
  }
}
