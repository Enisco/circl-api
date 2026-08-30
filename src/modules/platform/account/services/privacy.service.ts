import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/infrastructure';
import { UpdatePrivacyDto } from '../dtos/account.dto';

/** The defaults a member holds until they touch a switch. */
const DEFAULTS = {
  personalisedFeed: true,
  useActivityForRecommendations: true,
  showInConnectDiscovery: true,
};

/**
 * The two switches on the Privacy screen (G7). One persisted only to LocalStorage and the other
 * was a plain bool in widget state that reset on every rebuild, so neither controlled anything.
 */
@Injectable()
export class PrivacyService {
  constructor(private readonly database: PrismaService) {}

  async get(userId: string) {
    const row = await this.database.privacyPreference.findUnique({ where: { userId } });

    return { data: this.toView(userId, row) };
  }

  /** Accepts any subset and returns the whole object, the same contract the notification matrix uses. */
  async update(userId: string, dto: UpdatePrivacyDto) {
    const data = {
      ...(dto.personalisedFeed !== undefined && { personalisedFeed: dto.personalisedFeed }),
      ...(dto.useActivityForRecommendations !== undefined && {
        useActivityForRecommendations: dto.useActivityForRecommendations,
      }),
      ...(dto.showInConnectDiscovery !== undefined && {
        showInConnectDiscovery: dto.showInConnectDiscovery,
      }),
    };

    const row = await this.database.privacyPreference.upsert({
      where: { userId },
      update: data,
      create: { userId, ...DEFAULTS, ...data },
    });

    return { data: this.toView(userId, row) };
  }

  /**
   * Whether the feed may rank for this member. False falls it back to plain recency and city,
   * which is what stops the switch being decorative.
   */
  async allowsPersonalisation(userId: string): Promise<boolean> {
    const row = await this.database.privacyPreference.findUnique({
      where: { userId },
      select: { personalisedFeed: true },
    });

    return row?.personalisedFeed ?? DEFAULTS.personalisedFeed;
  }

  private toView(
    userId: string,
    row: {
      personalisedFeed: boolean;
      useActivityForRecommendations: boolean;
      showInConnectDiscovery: boolean;
      updatedAt: Date;
    } | null,
  ) {
    return {
      personalisedFeed: row?.personalisedFeed ?? DEFAULTS.personalisedFeed,
      useActivityForRecommendations:
        row?.useActivityForRecommendations ?? DEFAULTS.useActivityForRecommendations,
      showInConnectDiscovery: row?.showInConnectDiscovery ?? DEFAULTS.showInConnectDiscovery,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }
}
