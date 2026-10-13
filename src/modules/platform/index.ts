// From a core module import the leaf barrels (`@/modules/platform/shared`), never this one: it
// pulls in every platform module, and `SearchModule` imports `UsersModule`, so going through here
// closes the cycle and Nest boots with one of the two undefined.
import { AccountCoreModule } from './account/account-core.module';
import { AppPolicyCoreModule } from './app/app-policy-core.module';
import { AppPolicyModule } from './app/app-policy.module';
import { AccountModule } from './account/account.module';
import { CommerceModule } from './commerce/commerce.module';
import { DealsModule } from './deals/deals.module';
import { PlatformJobsModule } from './jobs/jobs.module';
import { CommunityModule } from './community/community.module';
import { ConnectModule } from './connect/connect.module';
import { CirclGuardModule } from './guard/guard.module';
import { GuardCoreModule } from './guard/guard-core.module';
import { IntelligenceCoreModule } from './intelligence/intelligence-core.module';
import { IntelligenceModule } from './intelligence/intelligence.module';
import { MediaCoreModule, MediaModule } from './media/media.module';
import { MessagingCoreModule, MessagingModule } from './messaging/messaging.module';
import { ModerationCoreModule } from './moderation/moderation-core.module';
import { ModerationModule } from './moderation/moderation.module';
import { NotificationsCoreModule, NotificationsModule } from './notifications/notifications.module';
import { ProfessionalsCoreModule } from './professionals/professionals-core.module';
import { ProfessionalsModule } from './professionals/professionals.module';
import { SearchModule } from './search/search.module';
import { PlatformSharedModule } from './shared/shared.module';
import { TaxonomyModule } from './taxonomy/taxonomy.module';
import { TrustModule } from './trust/trust.module';

/** The product sections, in dependency order. */
export const PLATFORM_MODULES = [
  PlatformSharedModule,
  // §5.21's public version gate. Early, because the force-update interceptor is global and a
  // provider it needs has to be resolvable before any product route is served.
  AppPolicyModule,
  NotificationsModule,
  IntelligenceModule,
  MessagingModule,
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
 * and a split would have to replace it with a call over the wire or a shared library. Each entry
 * is there for a reason that can be said in a sentence:
 *
 *  - shared: media signing, the taxonomy, and the serialisers every response shape is built from.
 *  - messaging: staff reply in Guard cases and support threads, which is the same thread the
 *    member is reading, so it has to be the same service writing to it.
 *  - media: signed URLs for the images attached to whatever is being moderated, and the upload
 *    tickets a staff reply's attachments need.
 *  - notifications: telling a member their content was removed.
 *  - account (core only): the member's own anonymisation and data-export paths, which staff run on
 *    their behalf for a legal request. One copy of the field-by-field destruction, not two.
 *
 * **Every entry is a `*CoreModule`, and that is load-bearing rather than a convention.** A module
 * that declares controllers mounts them wherever it is imported, so the first three entries here
 * each put a member API on the staff host until §5.15 split them.
 *
 * Keep it short. Every addition is a thing the two services would have to agree about forever —
 * and the one that is deliberately NOT here is the job runner. It schedules every product
 * section's work, so importing it would pull most of the member API into the admin process and
 * make `APP_SURFACE=admin` serve every member route. The admin API reaches it by name instead
 * (`AdminJobRunnerService`), and §5.22 replaces even that with a queued run.
 */
export const ADMIN_SURFACE_DEPENDENCIES = [
  // Intelligence (one service): approving an `AUTO_GUIDE` queue item publishes the draft guide,
  // so the staff process needs `AutoGuideService`. Not `IntelligenceModule`, which mounts the
  // Pulse controller and eight services the admin API never calls.
  IntelligenceCoreModule,
  // Guard (core only): §5.12's manual escalation opens the member's **existing** private thread
  // (D36), and that rule lives in one transaction in `GuardService`. The *core* module, because
  // `CirclGuardModule` mounts `GuardController` and a staff process serving `POST guard/threads`
  // would be a member endpoint in a place nobody is looking for one.
  GuardCoreModule,
  PlatformSharedModule,
  // Three *core* modules, for the same reason as the four above and because they were the three
  // that got it wrong: each one carried its member controllers until §5.15, so `APP_SURFACE=admin`
  // mounted twenty-four member routes — the whole messaging API, the notification feed, the
  // notification preferences, presence and the member upload ticket. None of them worked there,
  // because the member JWT strategy is not registered on this surface, so each answered a 500.
  //  - notifications: telling a member their content was removed.
  //  - messaging: the staff reply, written into the member's own thread.
  //  - media: signing what is being moderated, and the upload tickets behind `POST
  //    admin/media/uploads` — which is the staff door onto the service the member route guards.
  NotificationsCoreModule,
  MessagingCoreModule,
  MediaCoreModule,
  // Moderation (core only): §5.10's escalation files a **staff** report into the target's case,
  // and "file a report" is §7.1's whole grouping — snapshot, re-scan, join or open, and the retry
  // for the one-open-case-per-target race. The *core* module, because `ModerationModule` mounts
  // `ModerationController` and a staff process serving `POST /moderation/reports` would be a
  // member endpoint nobody is looking for there.
  ModerationCoreModule,
  // §5.21's version verdict, for the staff screen that sets the policy. The **core** module: the
  // public `GET /app/version-policy` is a member route, and mounting it here would put one on the
  // staff host. The surface test asserts exactly that and caught the first version of this.
  AppPolicyCoreModule,
  // Professionals (core only): §5.16's brief placement creates the booking **the member would
  // have created themselves** — same state, same thread, same notification to the professional,
  // same `NOT_ACCEPTING_WORK` refusal — and §5.17 reads a dispute's subject. The *core* module,
  // because `ProfessionalsModule` mounts four member controllers and a staff process serving
  // `POST /professionals/bookings` would be a member endpoint nobody is looking for there.
  ProfessionalsCoreModule,
  // Account deletion and data export, for the two §5.5 actions staff take on a member's behalf.
  // The *core* module, not `AccountModule`: that one mounts three member controllers, and a staff
  // process serving `DELETE /account` would be a member-facing endpoint nobody is looking for.
  AccountCoreModule,
];

export * from './notifications';
export * from './shared';
