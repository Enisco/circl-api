import { AccountModule } from './account/account.module';
import { AdminModule } from './admin/admin.module';
import { CommerceModule } from './commerce/commerce.module';
import { PlatformJobsModule } from './jobs/jobs.module';
import { CommunityModule } from './community/community.module';
import { ConnectModule } from './connect/connect.module';
import { CirclGuardModule } from './guard/guard.module';
import { IntelligenceModule } from './intelligence/intelligence.module';
import { MediaModule } from './media/media.module';
import { MessagingCoreModule } from './messaging/messaging.module';
import { ModerationModule } from './moderation/moderation.module';
import { ProfessionalsModule } from './professionals/professionals.module';
import { PlatformSharedModule } from './shared/shared.module';
import { TaxonomyModule } from './taxonomy/taxonomy.module';
import { TrustModule } from './trust/trust.module';

/**
 * The product sections, in dependency order.
 *
 * The first five are global and come first because every section below reads
 * from them. Taxonomy and Media are next for the reason spec 1.0.2 gives: every
 * composer and every filter needs category codes, city ids and an upload URL
 * before it can exist.
 */
export const PLATFORM_MODULES = [
  PlatformSharedModule,
  IntelligenceModule,
  MessagingCoreModule,
  TrustModule,
  TaxonomyModule,
  MediaModule,
  CommunityModule,
  ProfessionalsModule,
  ConnectModule,
  CommerceModule,
  ModerationModule,
  CirclGuardModule,
  AccountModule,
  AdminModule,
  PlatformJobsModule,
];

export * from './shared';
