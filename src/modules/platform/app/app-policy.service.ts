import { Injectable } from '@nestjs/common';
import { SYSTEM_CONFIG_KEYS, atLeast, compareVersions, isSemver } from '@/common';
import { SystemConfigService } from '@/modules/platform/shared';

export type VersionStatus = 'OK' | 'SOFT_UPDATE' | 'FORCE_UPDATE';

export interface VersionPolicyView {
  status: VersionStatus;
  latest: string;
  storeUrl: string | null;
  message: string | null;
}

/**
 * The version gate, in one place (§5.21).
 *
 * Read by two callers that must never disagree: the public endpoint a client asks on launch, and
 * the interceptor that refuses a request from a build below the floor. Two copies of "is this
 * build allowed" is an app told it may continue by one and refused by the other.
 */
@Injectable()
export class AppPolicyService {
  constructor(private readonly config: SystemConfigService) {}

  /**
   * The verdict for one build.
   *
   * An unknown platform or an unparseable version answers `OK`. The floor is a statement about
   * builds we know about, and locking somebody out over a header we could not read is the wrong
   * way to be wrong — the member cannot fix it, cannot be told what to fix, and the web client
   * sends no version at all.
   */
  async decide(platform: string | null, version: string | null): Promise<VersionPolicyView> {
    const policy = await this.config.get(SYSTEM_CONFIG_KEYS.APP_VERSIONS);
    const forPlatform = platform === 'IOS' || platform === 'ANDROID' ? policy[platform] : null;

    if (!forPlatform) {
      return { status: 'OK', latest: policy.IOS?.latest ?? '0.0.0', storeUrl: null, message: null };
    }

    const answer = (status: VersionStatus): VersionPolicyView => ({
      status,
      latest: forPlatform.latest,
      storeUrl: forPlatform.storeUrl ?? null,
      message: (forPlatform as { message?: string | null }).message ?? null,
    });

    if (!isSemver(version)) return answer('OK');

    if (!atLeast(version, forPlatform.forceBelow)) return answer('FORCE_UPDATE');

    // A soft update is "there is something newer", not "you are below the minimum": the minimum is
    // what support reads to know whether a bug report is against a build we still carry, and
    // nagging only at that line would leave most of the fleet never asked to move.
    if (compareVersions(version, forPlatform.latest) < 0) return answer('SOFT_UPDATE');

    return answer('OK');
  }
}
