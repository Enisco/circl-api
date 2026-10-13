import { Injectable } from '@nestjs/common';
import {
  ApiErrorCode,
  ApiException,
  ConfigGroup,
  SYSTEM_CONFIG_DEFAULTS,
  SYSTEM_CONFIG_KEYS,
  SYSTEM_CONFIG_META,
  SystemConfigKey,
  checkConfigValue,
  compareVersions,
  isSemver,
} from '@/common';
import { PrismaService } from '@/infrastructure';
import { MediaService, SystemConfigService } from '@/modules/platform/shared';
import { AuditService } from '../audit/audit.service';
import { AdminPrincipal } from '../common/admin-principal';
import { UpdateAppVersionsDto, UpdateConfigDto } from '../dtos/admin-config.dto';
import { StaffRefView, staffRefSelect, toStaffRef } from '../serializers/admin-staff.serializer';

/** How far back "still in the wild" reaches, for the adoption table (§5.21). */
const ADOPTION_DAYS = 30;

/** §2.7's floor, applied here too: a version used by fewer than ten people is not reported. */
const ADOPTION_FLOOR = 10;

/**
 * The store host per platform.
 *
 * Fixed rather than validated as "an https url", because this url is shown on a screen a member
 * cannot dismiss: a force-update pointing at somebody else's page is a phishing link the platform
 * served, with the full weight of "you must update to continue" behind it.
 */
const STORE_HOSTS: Record<'IOS' | 'ANDROID', string[]> = {
  IOS: ['apps.apple.com', 'itunes.apple.com'],
  ANDROID: ['play.google.com'],
};

export interface ConfigEntryView {
  key: string;
  label: string;
  group: ConfigGroup;
  description: string;
  value: unknown;
  default: unknown;
  /** The rule a `PATCH` is checked against, rendered for the form that draws the field. */
  schema: unknown;
  updatedAt: string | null;
  updatedBy: StaffRefView | null;
}

/**
 * §5.21: the settings staff can change without a deploy, and the app version policy.
 *
 * Two endpoints that look alike and are not. The config list is twenty-two values with a rule
 * each; the version policy is one value that can lock every member out of the app, which is why it
 * has its own endpoint, its own validation and its own audit action rather than being the
 * twenty-third row in the table.
 *
 * Everything here reads and writes through `SystemConfigService`, which is also what the rest of
 * the platform reads. It caches for sixty seconds, so a change takes effect within a minute
 * without a deploy and without this service knowing how any of its consumers work.
 */
@Injectable()
export class AdminConfigService {
  constructor(
    private readonly database: PrismaService,
    private readonly config: SystemConfigService,
    private readonly media: MediaService,
    private readonly audit: AuditService,
  ) {}

  /** Every key, its current value and its default, in the order the settings screen groups them. */
  async list(): Promise<ConfigEntryView[]> {
    const keys = Object.keys(SYSTEM_CONFIG_META);
    const rows = await this.database.systemConfig.findMany({ where: { key: { in: keys } } });
    const byKey = new Map(rows.map(row => [row.key, row]));
    const staff = await this.staffFor(rows.map(row => row.updatedById));

    const entries = await Promise.all(
      keys.map(async key => {
        const meta = SYSTEM_CONFIG_META[key];
        const row = byKey.get(key);

        return {
          key,
          label: meta.label,
          group: meta.group,
          description: meta.description,
          // Read through the service rather than off the row, so the value shown is the value the
          // platform is actually using — including the coercion it applies to a stored override of
          // the wrong shape.
          value: await this.config.get(key as SystemConfigKey),
          default: (SYSTEM_CONFIG_DEFAULTS as Record<string, unknown>)[key],
          schema: renderRule(meta.rule),
          updatedAt: row?.updatedAt?.toISOString() ?? null,
          updatedBy: row?.updatedById ? (staff.get(row.updatedById) ?? null) : null,
        };
      }),
    );

    const order: ConfigGroup[] = ['LIMITS', 'SAFETY', 'SLAS', 'OPERATIONS'];

    return entries.sort(
      (a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.key.localeCompare(b.key),
    );
  }

  /** One value, checked against its own rule and recorded with the reason it changed. */
  async update(actor: AdminPrincipal, key: string, dto: UpdateConfigDto): Promise<ConfigEntryView> {
    const reason = dto.assertReasoned();
    const meta = SYSTEM_CONFIG_META[key];

    if (!meta) {
      // The known keys come back with it, because a typo in a key name is the likeliest cause and
      // a 404 that cannot say what was available makes somebody guess.
      throw ApiException.notFound(`There is no setting called "${key}".`, ApiErrorCode.NOT_FOUND, {
        data: { keys: Object.keys(SYSTEM_CONFIG_META) },
      });
    }

    const problems = checkConfigValue(meta.rule, dto.value);

    if (problems.length) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        `That value is not storable: ${problems[0]}`,
        { details: problems.map(message => ({ field: 'value', message })) },
      );
    }

    const before = await this.config.get(key as SystemConfigKey);

    await this.audit.mutate(
      {
        action: 'config.updated' as const,
        targetType: 'CONFIG' as const,
        targetId: key,
        targetLabel: meta.label,
        before: { value: before },
        after: { value: dto.value },
        reasonCode: reason.reasonCode,
        policySubtype: reason.policySubtype,
        reason: reason.note,
      },
      tx =>
        tx.systemConfig.upsert({
          where: { key },
          update: { value: dto.value as never, updatedById: actor.id },
          create: {
            key,
            value: dto.value as never,
            description: meta.description,
            updatedById: actor.id,
          },
        }),
    );

    // The cache is a minute long and this endpoint is how somebody checks their own change took,
    // so it is cleared here rather than waited out.
    await this.config.invalidate(key as SystemConfigKey);

    const entries = await this.list();

    return entries.find(entry => entry.key === key)!;
  }

  // ─── App versions ──────────────────────────────────────────────────────────

  async appVersions() {
    const [policy, adoption, row] = await Promise.all([
      this.config.get(SYSTEM_CONFIG_KEYS.APP_VERSIONS),
      this.adoption(),
      this.database.systemConfig.findUnique({
        where: { key: SYSTEM_CONFIG_KEYS.APP_VERSIONS },
        select: { updatedAt: true, updatedById: true },
      }),
    ]);

    const staff = await this.staffFor([row?.updatedById ?? null]);

    return {
      ...policy,
      adoption,
      updatedAt: row?.updatedAt?.toISOString() ?? null,
      updatedBy: row?.updatedById ? (staff.get(row.updatedById) ?? null) : null,
    };
  }

  /**
   * Replaces the whole policy, both platforms at once.
   *
   * `PUT` rather than `PATCH` because the four versions constrain each other: a `forceBelow` sent
   * on its own would be checked against a `minimum` somebody else changed a moment ago, and the
   * ordering is the only thing standing between a typo and every member of one platform locked out.
   */
  async updateAppVersions(actor: AdminPrincipal, dto: UpdateAppVersionsDto) {
    const reason = dto.assertReasoned();
    const before = await this.config.get(SYSTEM_CONFIG_KEYS.APP_VERSIONS);

    for (const platform of ['IOS', 'ANDROID'] as const) {
      this.assertPlatform(platform, dto[platform]);
    }

    const value = {
      IOS: this.toPolicy(dto.IOS),
      ANDROID: this.toPolicy(dto.ANDROID),
    };

    await this.audit.mutate(
      {
        action: 'config.app_versions_updated' as const,
        targetType: 'CONFIG' as const,
        targetId: SYSTEM_CONFIG_KEYS.APP_VERSIONS,
        targetLabel: 'App versions',
        before: { value: before },
        after: { value },
        reasonCode: reason.reasonCode,
        policySubtype: reason.policySubtype,
        reason: reason.note,
        // The one fact a reader of the trail wants first: did this force anybody out, and from
        // which build. Derived here rather than left to be worked out from two version strings.
        metadata: {
          forcesUpdate: {
            IOS: dto.IOS.forceBelow !== (before.IOS?.forceBelow ?? null),
            ANDROID: dto.ANDROID.forceBelow !== (before.ANDROID?.forceBelow ?? null),
          },
        },
      },
      tx =>
        tx.systemConfig.upsert({
          where: { key: SYSTEM_CONFIG_KEYS.APP_VERSIONS },
          update: { value: value as never, updatedById: actor.id },
          create: {
            key: SYSTEM_CONFIG_KEYS.APP_VERSIONS,
            value: value as never,
            description: 'The app version policy (§5.21).',
            updatedById: actor.id,
          },
        }),
    );

    await this.config.invalidate(SYSTEM_CONFIG_KEYS.APP_VERSIONS);

    return this.appVersions();
  }

  /** Semver, ordered, and a store url on the platform's own host. */
  private assertPlatform(
    platform: 'IOS' | 'ANDROID',
    given: { minimum: string; latest: string; forceBelow: string; storeUrl: string },
  ): void {
    const refuse = (field: string, message: string) => {
      throw ApiException.unprocessable(ApiErrorCode.VALIDATION_FAILED, message, {
        details: [{ field: `${platform}.${field}`, message }],
      });
    };

    for (const field of ['minimum', 'latest', 'forceBelow'] as const) {
      if (!isSemver(given[field])) {
        refuse(field, `${platform} ${field} must be a version like 1.4.0.`);
      }
    }

    // `forceBelow ≤ minimum ≤ latest`. Out of order, the policy contradicts itself: a `forceBelow`
    // above `latest` locks out the newest build in the store, which is every member.
    if (compareVersions(given.forceBelow, given.minimum) > 0) {
      refuse(
        'forceBelow',
        `${platform}: the forced-update floor (${given.forceBelow}) cannot be above the minimum supported version (${given.minimum}).`,
      );
    }

    if (compareVersions(given.minimum, given.latest) > 0) {
      refuse(
        'minimum',
        `${platform}: the minimum supported version (${given.minimum}) cannot be above the latest release (${given.latest}).`,
      );
    }

    let host: string;

    try {
      const url = new URL(given.storeUrl);

      if (url.protocol !== 'https:')
        refuse('storeUrl', `${platform}: the store link must be https.`);

      host = url.hostname.toLowerCase();
    } catch {
      refuse('storeUrl', `${platform}: that is not a URL.`);

      return;
    }

    if (!STORE_HOSTS[platform].includes(host)) {
      refuse(
        'storeUrl',
        `${platform}: the store link has to be on ${STORE_HOSTS[platform].join(' or ')}, not ${host}.`,
      );
    }
  }

  private toPolicy(given: {
    minimum: string;
    latest: string;
    forceBelow: string;
    storeUrl: string;
    message?: string;
  }) {
    return {
      minimum: given.minimum,
      latest: given.latest,
      forceBelow: given.forceBelow,
      storeUrl: given.storeUrl,
      message: given.message?.trim() || null,
    };
  }

  /**
   * Which builds are still in use, from the session table.
   *
   * Thirty days of `last_active_at`, which is the honest window: a build nobody has opened in a
   * month is not in the wild, however many installs it once had. Counts below ten are suppressed
   * (§2.7) — a version used by three people identifies them in a small city.
   */
  private async adoption() {
    const since = new Date(Date.now() - ADOPTION_DAYS * 86_400_000);
    const rows = await this.database.$queryRaw<
      Array<{ platform: string | null; version: string; members: bigint }>
    >`
      SELECT s."platform"::text AS platform,
             s."app_version" AS version,
             COUNT(DISTINCT s."user_id") AS members
      FROM "user_sessions" s
      WHERE s."app_version" IS NOT NULL
        AND s."platform" IS NOT NULL
        AND s."last_active_at" >= ${since}
      GROUP BY 1, 2
    `;

    return rows
      .map(row => ({
        platform: row.platform as 'IOS' | 'ANDROID',
        version: row.version,
        activeMembers30d: Number(row.members) < ADOPTION_FLOOR ? null : Number(row.members),
      }))
      .sort(
        (a, b) => a.platform.localeCompare(b.platform) || compareVersions(b.version, a.version),
      );
  }

  private async staffFor(ids: Array<string | null>) {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];

    if (!wanted.length) return new Map<string, StaffRefView>();

    const rows = await this.database.user.findMany({
      where: { id: { in: wanted } },
      select: staffRefSelect,
    });

    return new Map(rows.map(row => [row.id, toStaffRef(row, this.media.sign)]));
  }
}

/**
 * The rule, as the form that draws the field needs it.
 *
 * JSON-shaped rather than the internal rule object, because a `RegExp` does not survive
 * serialisation — it comes out as `{}`, which the portal would read as "no constraint" and then
 * accept `9am` for a clock time.
 */
const renderRule = (rule: unknown): unknown => {
  if (!rule || typeof rule !== 'object') return rule;

  const entries = Object.entries(rule as Record<string, unknown>).map(([key, value]) => {
    if (value instanceof RegExp) return [key, value.source];
    if (Array.isArray(value)) return [key, value];
    if (value && typeof value === 'object') return [key, renderRule(value)];

    return [key, value];
  });

  return Object.fromEntries(entries);
};
