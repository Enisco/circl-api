// From a core module import the leaf barrels (`@/modules/platform/shared`), never this one: it
// pulls in every platform module, and `SearchModule` imports `UsersModule`, so going through here
// closes the cycle and Nest boots with one of the two undefined.
import { AccountCoreModule } from './account/account-core.module';
import { AccountModule } from './account/account.module';
import { CommerceModule } from './commerce/commerce.module';
import { DealsModule } from './deals/deals.module';
import { PlatformJobsModule } from './jobs/jobs.module';
import { CommunityModule } from './community/community.module';
import { ConnectModule } from './connect/connect.module';
import { CirclGuardModule } from './guard/guard.module';
import { IntelligenceModule } from './intelligence/intelligence.module';
import { MediaModule } from './media/media.module';
import { MessagingCoreModule } from './messaging/messaging.module';
import { ModerationModule } from './moderation/moderation.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ProfessionalsModule } from './professionals/professionals.module';
import { SearchModule } from './search/search.module';
import { PlatformSharedModule } from './shared/shared.module';
import { TaxonomyModule } from './taxonomy/taxonomy.module';
import { TrustModule } from './trust/trust.module';

/** The product sections, in dependency order. */
export const PLATFORM_MODULES = [
  PlatformSharedModule,
  NotificationsModule,
  IntelligenceModule,
  MessagingCoreModule,
  TrustModule,
  TaxonomyModule,
  MediaModule,
  CommunityModule,
  ProfessionalsModule,
  ConnectModule,
  CommerceModule,
  // After both sections a deal can belong to.
  DealsModule,
  // After the four sections it searches.
  SearchModule,
  ModerationModule,
  CirclGuardModule,
  AccountModule,
  PlatformJobsModule,
];

/**
 * The member modules the admin API needs in its own process.
 *
 * Declared, rather than left to whatever a dependency graph happens to drag in, because this list
 * IS the cost of splitting the two services: each entry is a member capability the staff API uses,
 * and a split would have to replace it with a call over the wire or a shared library. Four
 * entries, each for a reason that can be said in a sentence:
 *
 *  - shared: media signing, the taxonomy, and the serialisers every response shape is built from.
 *  - messaging: staff reply in Guard cases and support threads, which is the same thread the
 *    member is reading, so it has to be the same service writing to it.
 *  - media: signed URLs for the images attached to whatever is being moderated.
 *  - notifications: telling a member their content was removed.
 *  - account (core only): the member's own anonymisation and data-export paths, which staff run on
 *    their behalf for a legal request. One copy of the field-by-field destruction, not two.
 *
 * Keep it short. Every addition is a thing the two services would have to agree about forever —
 * and the one that is deliberately NOT here is the job runner. It schedules every product
 * section's work, so importing it would pull most of the member API into the admin process and
 * make `APP_SURFACE=admin` serve every member route. The admin API reaches it by name instead
 * (`AdminJobRunnerService`), and §5.22 replaces even that with a queued run.
 */
export const ADMIN_SURFACE_DEPENDENCIES = [
  PlatformSharedModule,
  NotificationsModule,
  MessagingCoreModule,
  MediaModule,
  // Account deletion and data export, for the two §5.5 actions staff take on a member's behalf.
  // The *core* module, not `AccountModule`: that one mounts three member controllers, and a staff
  // process serving `DELETE /account` would be a member-facing endpoint nobody is looking for.
  AccountCoreModule,
];

export * from './notifications';
export * from './shared';
