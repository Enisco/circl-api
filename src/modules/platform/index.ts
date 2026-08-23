import { CommunityModule } from './community/community.module';
import { IntelligenceModule } from './intelligence/intelligence.module';
import { MediaModule } from './media/media.module';
import { ModerationModule } from './moderation/moderation.module';
import { PlatformSharedModule } from './shared/shared.module';
import { TaxonomyModule } from './taxonomy/taxonomy.module';

/**
 * The product sections, in dependency order.
 *
 * Shared and Intelligence are global and come first because every section below
 * reads from them. Taxonomy and Media come next for the same reason: spec 1.0.2
 * puts them at the top of the build order because every composer and every filter
 * needs category codes, city ids and an upload URL before it can exist.
 */
export const PLATFORM_MODULES = [
  PlatformSharedModule,
  IntelligenceModule,
  TaxonomyModule,
  MediaModule,
  CommunityModule,
  ModerationModule,
];

export * from './shared';
